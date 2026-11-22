YouTube 的视频分片请求长这样:

text

https://rr3---sn-xxxxxx.googlevideo.com/videoplayback?...&mn=sn-xxxxxx,sn-yyyyyy&mvi=3&...
rr3---sn-xxxxxx 是当前使用的 CDN 节点。
mn 参数列出了服务器给这个视频分配的主节点和备用节点。
脚本做三件事:

拦截 fetch,统计每个分片的下载速度。
连续几次低于阈值,就把后续请求的主机名换成 mn 里的另一个节点。
换节点后请求失败(403、网络错误等),自动回退到原节点,并把该节点标记为不可用。
默认参数 
const CFG = {
    minBytes: 256 * 1024,   // 小于该大小的响应不参与测速
    slowMbps: 18,           // 低于该速度算慢
    slowCount: 1,           // 连续慢多少次后切换
    cooldownMs: 120,        // 两次切换的最小间隔
    toast: true,            // 是否显示切换提示
    toastMs: 3500,          // 提示显示时长
