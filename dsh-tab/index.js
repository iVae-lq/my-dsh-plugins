/**
 * dsh-tab 的宿主半。
 *
 * 本插件的贡献全在浏览器侧（`exports["./client"]`），宿主侧没有任何事要做。
 * 这里保留一个空 `apply`，让 Loader 有一行可挂的条目；与官方纯前端插件的宿主半同形。
 */
export function apply() {}
