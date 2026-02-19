import pluginmanager from './pluginmanager.js'
import redis from "./redis.js"

function getFormattedDate() {
    const now = new Date()

    const pad = n => String(n).padStart(2, "0")

    const hours = pad(now.getHours())
    const minutes = pad(now.getMinutes())
    const seconds = pad(now.getSeconds())
    const day = pad(now.getDate())
    const month = pad(now.getMonth() + 1)
    const year = now.getFullYear()

    return `${hours}:${minutes}:${seconds}T${day}.${month}.${year}`
}

const GLOBAL_LIMIT = 100
const WINDOW_MS = 60 * 1000
let globalCallTimestamps = []
let skipped = 0

function rateLimit() {
    const now = Date.now()
    const windowStart = now - WINDOW_MS
    globalCallTimestamps = globalCallTimestamps.filter(timestamp => timestamp > windowStart)
    if (globalCallTimestamps.length >= GLOBAL_LIMIT) {
        skipped++
        return true
    }
    if (skipped > 0) {
    	pluginmanager.hook("logger-skipped-lines", skipped)
        console.log(`${getFormattedDate()} [INFO][logger] Skipped ${skipped} lines`)
    	skipped = 0
    }
    globalCallTimestamps.push(now)
    return false
}

function info(...args) {
    if (rateLimit()) { return }
    const date = getFormattedDate()
    const lines = args.join(' ').split("\n")
    for (const line in lines) {
        lines[line] = `${date} [INFO]${lines[line]}`
    }
    console.log(lines.join("\n"))
    pluginmanager.hook("logger-info", lines.join("\n"))
}

function warn(...args) {
    const date = getFormattedDate()
    const lines = args.join(' ').split("\n")
    for (const line in lines) {
        lines[line] = `${date} [WARN]${lines[line]}`
    }
    console.warn(lines.join("\n"))
    pluginmanager.hook("logger-warn", lines.join("\n"))
    //redis.lPush('logs:warn', lines.join("\n"))
    //    .then(() => redis.lTrim('logs:warn', 0, 1000))
    //    .catch(e=>console.error(`${date} [ERROR][REDIS] ${e}`))
}

function err(...args) {
    const date = getFormattedDate()
    const lines = args.join(' ').split("\n")
    for (const line in lines) {
        lines[line] = `${date} [ERROR]${lines[line]}`
    }
    console.error(lines.join("\n"))
    pluginmanager.hook("logger-error", lines.join("\n"))
    //redis.lPush('logs:err', lines.join("\n"))
    //    .then(() => redis.lTrim('logs:err', 0, 1000))
    //    .catch(e=>console.error(`${date} [ERROR][REDIS] ${e}`))
}

export default {
    info: info,
    warn: warn,
    error: err,
}