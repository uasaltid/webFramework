import pluginmanager from './pluginmanager.js'
import { signals } from "./builder.js"
import logger from "./logger.js"
import client from "./redis.js"
import fs from 'fs/promises'
import crypto from 'crypto'

const hash = (b, a) => crypto.createHash(b).update(a).digest('hex')

// Статистика запросов к серверу
function getDateKeys() {
    const now = new Date()
    const dayKey = `stats:requests:day:${now.toISOString().substring(0, 10)}` // YYYY-MM-DD
    const weekNumber = Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / (1000 * 60 * 60 * 24 * 7))
    const weekKey = `stats:requests:week:${now.getFullYear()}-${weekNumber}`
    
    return { dayKey, weekKey }
}

// Записать новый запрос
async function recordRequest() {
    const { dayKey, weekKey } = getDateKeys()
    await client.incr(dayKey)
    await client.expire(dayKey, 60 * 60 * 25)

    await client.incr(weekKey)
    await client.expire(weekKey, 60 * 60 * 24 * 8)
}

async function getAverageRequestsPerDayInLastWeek() {
    const totalDays = 7;
    let totalRequests = 0;
    
    for (let i = 0; i < totalDays; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i)

        const dateString = date.toISOString().substring(0, 10)
        const dayKey = `stats:requests:day:${dateString}`
        
        const count = await client.get(dayKey)
        totalRequests += parseInt(count || 0, 10)
    }
    
    const average = totalRequests / totalDays;
    
    return {
        totalRequestsLastWeek: totalRequests,
        averagePerDay: average
    }
}

async function getDailyRequests(days = 7) {
    const data = []
    for (let i = 0; i < days; i++) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        const dateString = date.toISOString().substring(0, 10)
        const dayKey = `stats:requests:day:${dateString}`
        
        const count = await client.get(dayKey)
        data.push(parseInt(count || 0, 10))
    }
    return data
}

function calculateStatistics(data) {
    if (data.length === 0) return { mean: 0, stdDev: 0 };

    // Вычисляем среднее арифметическое (mean)
    const mean = data.reduce((sum, value) => sum + value, 0) / data.length;

    // Вычисляем среднеквадратичное отклонение (standard deviation)
    const squareDiffs = data.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((sum, value) => sum + value, 0) / data.length;
    const stdDev = Math.sqrt(avgSquareDiff);

    return { mean, stdDev };
}

async function getAnomalyThreshold(days = 7) {
    const historicalData = await getDailyRequests(days)
    if (historicalData.length < 3) {
        return null
    }
    
    const { mean, stdDev } = calculateStatistics(historicalData)
    
    const threshold = mean + 2 * stdDev
    
    return threshold
}

async function underAttack() {
    // TODO отправка запроса к Cloudflare что бы включил режим UnderAttack
    logger.warn("[analytics] Server under attack!")
	pluginmanager.hook("analytics-under-attack")
}

async function checkCurrentTrafficAndExecute(currentRequests) {
    const threshold = await getAnomalyThreshold(4)
    if (threshold === null) {
        return
    }
    
    if (currentRequests > threshold) {
        await underAttack()
    }
}

setInterval(async () => {
    const { dayKey, weekKey } = getDateKeys()
    checkCurrentTrafficAndExecute(await client.get(dayKey))
}, 5000)

await signals("reganalytics", async function (ip, headers) {
    recordRequest()
    if (!headers['user-agent']) {
        headers['user-agent'] = "No User-Agent"
    }

    if (!await client.exists(ip)) {
        await client.rPush(ip, headers['user-agent'])
    	await client.expire(ip, 60 * 10)
    } else {
        await client.rPush(ip, headers['user-agent'])
        let duplicates = []
        let unique = new Set()
        let array = await client.lRange(ip, 0, -1)

        for (const agent of array) {
            const normalizedagent = agent.trim().toLowerCase()

            if (unique.has(normalizedagent)) {
                duplicates.push(agent)
            } else {
                unique.add(normalizedagent)
            }
        }
        if (array.length > 5 && unique.keys() > 5 && duplicates.length < 5) {
            let defaults = await fs.readFile('./defaults.conf')
            defaults = defaults ? JSON.parse(defaults) : {}
            if (!defaults.protection) {
                defaults.protection = {
                    enabled: true,
                    blockedIP: []
                }
            }
            if (!defaults.protection.blockedIP) {
                defaults.protection.blockedIP = []
            }
            defaults.protection.blockedIP.push(ip)
            await fs.writeFile('./defaults.conf', JSON.stringify(defaults, undefined, 4))
            await signals("updatevars")
        }
    }
})

logger.info("[analytics] Analytics collection started")
pluginmanager.hook("analytics-collection")