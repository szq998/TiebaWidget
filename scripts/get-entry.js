const getTiebaPost = require('./get-tieba-post');
const doWithTimeout = require('./util/do-with-timeout');
const getFileMTime = require('./util/get-file-mtime');
const logError = require('./util/log-error');

const {
    POST_INFO_TIMEOUT,
    IMAGE_TIMEOUT,
    IMAGE_DOWNLOAD_DIR,
    MAX_NUMBER_OF_POST,
    DEFAULT_REFRESH_CIRCLE,
    MAX_IMAGE_SIZE,
    IMAGE_CLEAR_INTERVAL,
    MAX_ABSTRACT_LEN_ALLOWING_TWO_IMAGES,
    DEBUG,
} = require('./constant');

async function selectImageBySize(imgUrls, maxSize, maxNumImg) {
    const selected = [];
    for (let i = 0; i < imgUrls.length && selected.length < maxNumImg; ++i) {
        const url = imgUrls[i];
        const {
            response: { expectedContentLength: len, error },
        } = await $http.request({ method: 'HEAD', url });

        if (!error && len && len <= maxSize) {
            selected.push(url);
        }
    }
    return selected;
}
/*
 * @description 下载一个贴子所需的图片，有摘要时最多下载一张，无摘要时最多下载三张。下载照片前首先获取图片尺寸，滤除过大的照片。
 * @param dst {string} 下载目录
 * @param item {object} 贴子数据，可能有imgDownloaded属性表示图片是否已经加载完毕、可能有imgPaths表示部分下在成功的图片、imgUrls数组存储所有图片url、abstract属性表示贴子摘要
 * @return {bool} 指示下载是否成功
 */
async function downloadImage(dst, item) {
    if (item.imgDownloaded || item.imgUrls.length === 0) {
        // 图片已经下载完毕或者本就没有图片
        return true;
    }
    // 无摘要最多显示三张图片, 有摘要酌情显示两张或一张图片
    const maxNumImg = !item.abstract
        ? 3
        : item.abstract.length < MAX_ABSTRACT_LEN_ALLOWING_TWO_IMAGES
        ? 2
        : 1;
    // 只获取较小尺寸的图片，防止超出小组件的资源限制，导致卡死
    let shownImgUrls = await selectImageBySize(
        item.imgUrls,
        MAX_IMAGE_SIZE,
        maxNumImg
    );
    if (!shownImgUrls.length) {
        // 没有符合的图片
        item.imgDownloaded = true;
        return true;
    }
    // 创建imgPaths数组
    if (!item.imgPaths) {
        item.imgDownloaded = false;
        item.imgPaths = [];
    }
    // 去除已经下载的图片
    shownImgUrls = shownImgUrls.filter((url) => {
        const name = url.split('/').slice(-1)[0];
        const path = `${dst}/${name}`;
        if (item.imgPaths.indexOf(path) !== -1) {
            // 图片已经下载且加入到了imgPaths中
            return false;
        }
        if ($file.exists(path)) {
            // 图片之前下载了，但没有在imgPaths中
            item.imgPaths.push(path);
            return false;
        }
        return true;
    });
    const downloadResults = await Promise.allSettled(
        shownImgUrls.map(async (url) => {
            // download
            const {
                response: { statusCode, error },
                rawData: data,
            } = await $http.get({ url });
            if (error) {
                throw error;
            }
            if (statusCode !== 200) {
                throw new Error(
                    `Image from "${url}" download failed with status code ${statusCode}`
                );
            }
            // write to disk
            const name = url.split('/').slice(-1)[0];
            const path = `${dst}/${name}`;
            const success = $file.write({ path, data });
            if (success) {
                item.imgPaths.push(path);
                return true;
            } else {
                throw new Error(
                    `Failed to write image data from "${url}" to "${path}"`
                );
            }
        })
    );
    // 使用Promise.allSettled，一张图片下载失败不会影响其他图片
    if (
        downloadResults.every(
            (v) => v.status === 'fulfilled' && v.value === true
        )
    ) {
        item.imgDownloaded = true;
        return true;
    } else {
        if (DEBUG) {
            // 滤出错误
            const errors = downloadResults
                .filter((v) => v.status === 'rejected')
                .map((v) => v.reason);
            if (!errors.length) {
                // 没有错误要记录
                return false;
            }
            console.error(errors);

            const errorInfoArr = errors.map((err) => ({
                message: err.message,
                stack: err.stack,
            }));
            logError({ dst, item, errors: errorInfoArr }, 'downloadImage');
        }
        return false;
    }
}

function prepareForImageDownload(dst) {
    try {
        // check the existence of image dir
        if (
            !$file.exists(IMAGE_DOWNLOAD_DIR) &&
            !$file.mkdir(IMAGE_DOWNLOAD_DIR)
        ) {
            throw new Error(
                `Failed to create folder "${IMAGE_DOWNLOAD_DIR}" for saving image`
            );
        }
        //  clear old images
        const lastClearDate = getFileMTime(dst);
        if (
            lastClearDate &&
            Date.now() - lastClearDate > IMAGE_CLEAR_INTERVAL
        ) {
            $file.delete(dst);
        }
        // check the existence of dst
        if (!$file.exists(dst) && !$file.mkdir(dst)) {
            throw new Error(
                `Failed to create folder "${dst}" for saving image`
            );
        }
        return true;
    } catch (err) {
        // 主要为超时
        if (DEBUG) {
            console.error(err);
            const errorInfo = { message: err.message, stack: err.stack };
            logError(errorInfo, 'prepareForImageDownload');
        }
        return false;
    }
}

/*
 * @description 在限定时间内下载图片
 * @param dst {string} 下载目录
 * @param items {Array} 所有要下载图片的贴子数据
 * @param maxTime {number} 限定时间，单位毫秒
 * @param partialDownloaded {bool} 若为true，则之前尝试过下载，可能有部分数据已在本地，则不进行目标目录存在性的检测和过期图片的清理
 * @return {bool} 指示下载是否成功
 */
async function tryDownloadAllImageWithTimeout(
    dst,
    items,
    maxTime,
    partialDownloaded
) {
    if (!partialDownloaded && !prepareForImageDownload(dst)) {
        return false;
    }

    try {
        const downloadResults = await doWithTimeout(
            // 使用allSettled而不是all，为了尽可能多加载图片，防止一个出错而使加载停止，即使downloadImage几乎捕获了所有错误
            () => Promise.allSettled(items.map(downloadImage.bind(null, dst))),
            maxTime
        );
        return downloadResults.every(
            (v) => v.status === 'fulfilled' && v.value === true
        );
    } catch (err) {
        // 主要为超时
        if (DEBUG) {
            console.error(err);
            const errorInfo = {
                dst,
                message: err.message,
                stack: err.stack,
                items,
            };
            logError(errorInfo, 'tryDownloadAllImageWithTimeout');
        }
        return false;
    }
}

async function tryGetTiebaPostWithTimeout(tiebaName, maxTime, maxNumPost) {
    try {
        return await doWithTimeout(
            getTiebaPost,
            maxTime,
            tiebaName,
            maxNumPost
        );
    } catch (err) {
        // 主要为超时
        if (DEBUG) {
            console.error(err);
            const errorInfo = { message: err.message, stack: err.stack };
            logError(errorInfo, `tryGetTiebaPostWithTimeout-${tiebaName}`);
        }
        return null;
    }
}

function isCacheValid(cache, nowDate) {
    return (
        cache &&
        cache.items &&
        cache.date &&
        nowDate - cache.date <
            ($prefs.get('refresh-circle') ?? DEFAULT_REFRESH_CIRCLE) * 60000
    );
}

async function getEntry(tiebaName, forceLoad) {
    if (!tiebaName) {
        return {
            info: null,
            date: null,
        };
    }

    let items = null;
    let date = null;
    const cached = await $cache.getAsync(tiebaName);
    const dst = `${IMAGE_DOWNLOAD_DIR}/${tiebaName}`;
    if (!forceLoad && isCacheValid(cached, new Date())) {
        // use cache
        ({ items, date } = cached);
        if (!cached.imgAllDownloaded) {
            // images are not completely downloaded
            const imgAllDownloaded = await tryDownloadAllImageWithTimeout(
                dst,
                items,
                IMAGE_TIMEOUT,
                true
            );
            // set cache
            $cache.setAsync({
                key: tiebaName,
                value: { items, date, imgAllDownloaded },
            });
        }
    } else {
        // no valid cache
        items = await tryGetTiebaPostWithTimeout(
            tiebaName,
            POST_INFO_TIMEOUT,
            MAX_NUMBER_OF_POST
        );
        if (items) {
            // fetch post successfully
            // set date
            date = new Date();
            // 下载图片
            const imgAllDownloaded = await tryDownloadAllImageWithTimeout(
                dst,
                items,
                IMAGE_TIMEOUT,
                false
            );
            // cache after image downloading
            $cache.setAsync({
                key: tiebaName,
                value: { items, date, imgAllDownloaded },
            });
        } else {
            // use cache if provided, even expired
            if (cached && cached.items && cached.date) {
                ({ items, date } = cached);
            }
        }
    }
    return { info: items, date };
}

module.exports = getEntry;
