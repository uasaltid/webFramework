import pluginmanager from './pluginmanager.js'
import { createClient } from "redis"
import fs from 'fs/promises'

let backup = 1*60

pluginmanager.on("redis-set-backup", e => {
    backup = e
})

async function exists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

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

let redisClient
try {
    redisClient = createClient({ url: "redis://localhost:6379" })
    await redisClient.connect()
    console.log(`${getFormattedDate()} [INFO][REDIS][CLIENT] Successfully connected to external Redis`)
} catch (e) {
    console.error(`${getFormattedDate()} [ERR][REDIS][CLIENT] Connection failed. Switching to fallback mode.`)
    pluginmanager.hook("redis-fallback-mode")
    
    let redisdata = {}
    !(async function(){
    	pluginmanager.hook("redis-loading-backup")
        let data = await exists("./redisFallback_backup.json") ? JSON.parse(await fs.readFile("./redisFallback_backup.json")) : {}
        for (let [name, recorddata] of Object.entries(data)) {
            if (recorddata.expires) {
                const end = recorddata.expires.set - recorddata.expires.ttl
                const expires = (end - Math.floor(Date.now() / 1000)) * 1000
                if (expires < 0) {
                    continue
                }
                recorddata.expires.timeout = setTimeout(() => delete redisdata[name], expires)
            }
            redisdata[name] = recorddata
        }
    	pluginmanager.hook("redis-loaded-backup")
    })()
    let updateBackup = async () => {
    	pluginmanager.hook("redis-saving-backup")
        let data = {}
        const date = new Date().getTime()
        for (let [name, recorddata] of Object.entries(redisdata)) {
            if (recorddata.expires) {
                delete recorddata.expires.timeout
            }
            data[name] = recorddata
        }
        await fs.writeFile("./redisFallback_backup.json", JSON.stringify(data, undefined, 4))
    	pluginmanager.hook("redis-saved-backup")
    }
    setInterval(updateBackup, backup * 1000)
    redisClient = {
        exists: async n => {
            if (redisdata[n]) {
                return true
            } else {
                return false
            }
        },
        get: async n => redisdata[n]?.data,
        set: async (n, data, options) => {
            redisdata[n] = {
                data: data,
            }
            if (options.EX) {
                redisdata[n].expires = {
                    ttl: options.EX * 1000,
                    timeout: setTimeout(() => delete redisdata[n], options.EX * 1000),
                    set: Math.floor(Date.now() / 1000)
                }
            }
        },
        incr: async n => {
            if (!redisdata[n]) {
                redisdata[n] = {
                    data: 0
                }
            }
            redisdata[n].data++
        },
        expire: (n, newexp) => {
            if (!redisdata[n]) return
            if (redisdata[n].expires) {
            	clearTimeout(redisdata[n].expires.timeout)
            }
            redisdata[n].expires = {
                timeout: setTimeout(() => delete redisdata[n], newexp * 1000),
                ttl: newexp * 1000,
                set: Math.floor(Date.now() / 1000)
            }
        },
        rPush: (n, data) => {
            if (!redisdata[n]) {
                redisdata[n] = { data: [] }
            }
			redisdata[n].data.push(data)
        },
        lPush: (n, data) => {
            if (!redisdata[n]) {
                redisdata[n] = { data: [] }
            }
			redisdata[n].data = [data, ...redisdata[n].data]
        },
        lRange: (n, starts, ends) => {
            return redisdata[n].data
        },
        del: (n) => {
            if (redisdata[n]) {
                if (redisdata[n].expires) {
                    clearTimeout(redisdata[n].expires.timeout)
                }
                delete redisdata[n]
            }
        },
        flushDB: () => {
            redisdata = {}
        }
    }
}

export default redisClient