import http from 'http'
import zlib from 'zlib'
import https from 'https'
import pathm from 'path'
import fs from 'fs/promises'
import ipaddr from "ipaddr.js"
import fss, { stat, statSync } from 'fs'
import readline from 'readline'
import logger from './logger.js'
import { promisify } from 'util'
import formidable from 'formidable'
import redis from "./redis.js"
import WebSocket, { WebSocketServer } from "ws"
import pluginmanager from './pluginmanager.js'
import tls from 'tls'

let domains = {}
const gzip = promisify(zlib.gzip)
const defaultDir = './web'

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let defaults = await exists('./defaults.conf') ? JSON.parse(await fs.readFile('./defaults.conf')) : {}
const mime = {
    js: 'application/javascript',
    html: 'text/html; charset=UTF-8',
    json: 'application/json',
    pdf: 'application/pdf',
    ico: 'image/x-icon',
    png: 'image/png',
    css: 'text/css',
    ttf: 'font/ttf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    ogg: 'video/ogg',
    mkv: 'video/x-matroska',
    flv: 'video/x-flv',
    mp3: 'audio/mpeg',
    wav: 'audio/x-wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
}

function app(domain, cors={}) {
    if (!domains[domain]) {
        domains[domain] = {}
        domains[domain].maintenance = false
        const settings = fss.readFileSync(`./web/${domain}/params.conf`)
        domains[domain].urls = []
        domains[domain].ws = []
        domains[domain].listeners = []
        if (settings) {
            domains[domain].settings = JSON.parse(settings)
        }
        domains[domain].cors = settings.cors || defaults.cors || {
            origin: '*',
            headers: '*',
            methods: '*'
        }
        domains[domain].protection = settings.protection || defaults.protection || {
            enabled: true,
            IPRateLimit: 240,
            UserAgentRateLimit: 320,
        }
        domains[domain].dns = {
            callback: undefined,
            records: settings?.dns?.records || []
        }
    }
 
    const appcontext = {
        root: `./web/${domain}/`,
        disable: (url, method) => {
            if (!method) { method = "GET" } else { method = method.toLocaleUpperCase() }
            for (const index in domains[domain].urls) {
                const event = domains[domain].urls[index]
                if (event.url == url && event.method == method) {
                    domains[domain].urls.splice(index, 1)
                    return true
                }
            }
            return false
        },
        destroy: () => {
            delete domains[domain]
        },
        ws: {
            route: (url, onopen=e=>{}, onmessage=e=>{}, onclose=e=>{}) => {
                domains[domain].ws.push({
                    url: url,
                    callback: {
                        onopen: onopen,
                        onmessage: onmessage,
                        onclose: onclose
                    }
                })
                return {
                    get clients() {
                        let clients = []
                        for (const client of socketWsServer.clients) {
                            if (!client.info && !client.info?.host && client.readyState != WebSocket.OPEN) {continue}
                            if (domain == client.info.host && client.info.url == url) {
                                clients.push(client)
                            }
                        }
                        clients
                    },
                    set clients(v) {
                        new Error("Clients ReadOnly")
                    }
                }
            }
        },
        on: (type, callback) => {
            if (type == "dns_request") {
                domains[domain].dns = callback
            }
        },
        set maintenance(v) {
            if (v == false || v == true) {
    			domains[domain].maintenance = v
            }
        },
        get maintenance() {domains[domain].maintenance},
    }
    for (const method of ["GET", "POST", "HEAD", "DELETE", 'PUT', 'OPTIONS', 'PATCH']) {
        appcontext[method.toLowerCase()] = (url, callback) => {
            domains[domain].urls.push({
                callback: callback,
                method: method.toUpperCase(),
                url: url,
            })
        }
    }
    return appcontext
}

export default app

async function parseParams(path, epath) {
    const pathSegs = path.split("/").filter(s => s !== "");
    const epathSegs = epath.split("/").filter(s => s !== "");
    
    let params = {};
    
    for (let i = 0; i < epathSegs.length; i++) {
        const eSeg = epathSegs[i];
        const pSeg = pathSegs[i];

        if (eSeg.startsWith('*')) {
            const paramName = eSeg.slice(1);
            params[paramName] = pathSegs.slice(i);
            return params
        }

        if (eSeg.startsWith(':')) {
            if (!pSeg) return false
            params[eSeg.slice(1)] = pSeg
            continue;
        }

        if (eSeg !== pSeg) {
            return false
        }
    }

    if (pathSegs.length > epathSegs.length) {
        return false
    }

    return params
}

async function HTTPProxy(req, res, url, ip) {
    let body = []
    req.on('data', chunk => body.push(chunk))
    req.on('end', async () => {
        try {
            const targetUrlStr = typeof url === 'object' ? url.url : url
            const configHeaders = typeof url === 'object' ? url.headers : {}
            const targetUri = new URL(targetUrlStr)

            const proxiedHeaders = {
                ...req.headers,
                'x-forwarded-host': req.headers.host,
                'x-real-ip': ip || "unknown",
                'accept-encoding': 'identity'
            }

            if (configHeaders) {
                for (const [k, v] of Object.entries(configHeaders)) {
                    proxiedHeaders[k.toLowerCase()] = v
                }
            }

            delete proxiedHeaders['connection']
            delete proxiedHeaders['content-length']

            const options = {
                hostname: targetUri.hostname,
                port: targetUri.port || (targetUri.protocol === 'https:' ? 443 : 80),
                path: encodeURI(targetUri.pathname.slice(1) + req.url).replace(/%25/g, '%'),
                method: req.method,
                headers: proxiedHeaders
            }

            const lib = targetUri.protocol === 'https:' ? https : http
            const proxyReq = lib.request(options, (proxyRes) => {
                const headers = {}
                Object.keys(proxyRes.headers).forEach(key => {
                    headers[key] = proxyRes.headers[key]
                })

                res.writeHead(proxyRes.statusCode, headers)
                proxyRes.pipe(res)
            })

            proxyReq.on('error', async (e) => {
                console.log(e)
                res.writeHead(502, { 'Content-Type': 'text/html' })
                res.end(await errPage('web/err.uasalt.org/badgateway.html'))
            })

            if (req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0) {
                proxyReq.write(Buffer.concat(body))
            }

            proxyReq.end()

        } catch (e) {
            console.log(e)
            res.writeHead(502, { 'Content-Type': 'text/html' })
            const bodyErr = await errPage('web/err.uasalt.org/badgateway.html')
            res.end(bodyErr)
        }
    })
}

async function errPage(path) { return await exists(path) ? await fs.readFile(path) : undefined}

async function mediaRange(ext, path, req, res) {
  let stat
  try {
  	stat = statSync(path)
  } catch {
    res.statusCode = 404
    return res.end("File not found")
  }
	if (!mime[ext]) {
        res.statusCode = 415
        return res.end()
    }

  const fileSize = stat.size
  const range = req.headers.range

  if (!range) {
    res.writeHead(200, {
      "Content-Type": mime[ext],
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
    });
    const stream = fss.createReadStream(path).pipe(res)
    stream.on('error', (err) => {
        if (!res.writableEnded) res.end();
    })
	req.on('close', () => stream.destroy())
    return
  }

  const match = range.match(/bytes=(\d+)-(\d*)/)
  if (!match) {
    res.statusCode = 416
    return res.end()
  }

  const start = Number(match[1])
  const end = match[2]
    ? Math.min(Number(match[2]), fileSize - 1)
    : fileSize - 1

  if (start >= fileSize || end >= fileSize) {
    res.statusCode = 416
    return res.end()
  }

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": mime[ext],
  })

  const stream = fss.createReadStream(path, { start, end })
  stream.pipe(res)
  req.on("close", () => stream.destroy())
}

async function handle(req, res) {
    let status = 200
    req.url = decodeURIComponent(req.url)
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip
    const country = req.headers["cf-ipcountry"]
    req.ip = ip
    const service = req.headers.host.split(":")[0]
    let protection = domains[service] ? domains[service]["protection"] : defaults.protection || {}
    let blocked = false
    let bid
    if (protection.enabled == undefined || protection.enabled == null) {
        protection.enabled = true
    }
    if (protection.enabled) {
        function block(reason) {
    		pluginmanager.hook("banned-web-request", { domain: service, ip, country, url: req.url, reason })
            res.destroy()
            {
                const ipString = ip ? `(${ip}${country ? `[${country}]` : ''})` : ''
                logger.info(`[${service}][${req.method}][BLOCKED] ${req.url} ${ipString} ${(req.headers['user-agent'] || "").slice(0, 48)}`)
            }
        }
        if (ip.includes(":") && protection.disAllowIPv6 == true) {
            return block("disallow-ipv6")
        }
        if (protection.blockedIP.includes(ip)) {
            return block("ip")
        }
        for (const ipf of Object.entries(protection.blockedIP)) {
            if (ipf.includes('/')) {
                let subnet = ipaddr.parseCIDR(ip)
                if (ipaddr.parse(ip).match(subnet)) {
            		return block("subnet")
                }
            }
        }
        if (req.headers["cf-ipcountry"] && !protection?.allowedIP?.includes(ip)) {
            if ((protection?.blockedCountry && protection?.blockedCountry.includes(req.headers["cf-ipcountry"])) ||
                (protection?.allowedCountry && !protection?.allowedCountry.includes(req.headers["cf-ipcountry"]))) {
                return block("country")
            }
        }
        let recordnameIP = `${ip}[RateLimitIP]`
        let recordnameUA = `${req.headers["user-agent"]}[RateLimitUserAgent]`
        await redis.incr(recordnameIP); await redis.incr(recordnameUA)
        await redis.expire(recordnameIP, 1800); await redis.expire(recordnameUA, 900)
        let countIP = await redis.get(recordnameIP) || 0
        let countUA = redis.get(recordnameUA) || 0
        
        res.setHeader("X-RateLimit-Limit", protection.IPRateLimit || 240)
        res.setHeader("X-RateLimit-Remaining", Math.max(0, (protection.IPRateLimit || 240) - countIP))
        
        if (countIP > (protection.IPRateLimit || 240)) {
            res.writeHead(429)
            res.end()
    		pluginmanager.hook("banned-web-request", { domain: service, ip, country, url: req.url, reason: "IPRateLimit" })
            return
        }
        if (countUA > (protection.UserAgentRateLimit || 320)) {
            res.writeHead(429)
            res.end()
    		pluginmanager.hook("banned-web-request", { domain: service, ip, country, url: req.url, reason: "UARateLimit" })
            return
        }
    	pluginmanager.hook("ban-request", { domain: service, ip, country, url: req.url})
        bid = pluginmanager.on("ban-request", e => {
            blocked = true
            block(`plugin-${e.reason || "unknownReason"}`)
        })
    }
    pluginmanager.hook("web-request", { domain: service, ip, country, url: req.url})
    
    const url = new URL(`https://${req.headers.host}${req.url}`)
    url.pathname = decodeURIComponent(url.pathname)
    const errP = domains[service]?.settings?.errorPages
    if (analyticsCb) analyticsCb(req.ip, req.headers)
	if (bid) pluginmanager.remove("ban-request", bid)
    {
        const ipString = ip ? `(${ip}${country ? `[${country}]` : ''})` : ''
        logger.info(`[${service}][${req.method}] ${req.url} ${ipString} ${req.headers['user-agent'] || ""}`)
    }
    
    if (domains[service] && domains[service].maintenance) {
        if (blocked) return
        pluginmanager.hook("skip-request", { reason: 'maintenance' })
        res.writeHead(403, { "Content-Type": "text/html" })
        res.end(await exists(`${defaultDir}/err.uasalt.org/maintenance.html`) ? await fs.readFile(`${defaultDir}/err.uasalt.org/maintenance.html`) : undefined)
        return
    }
    if (!url.pathname.split(".").slice(0, -1).pop() && domains[service]) {
        res.setHeader('Access-Control-Allow-Origin', domains[service].cors.origin)
        res.setHeader('Access-Control-Allow-Headers', domains[service].cors.headers)
        res.setHeader('Access-Control-Allow-Methods', domains[service].cors.methods)
        if (req.method == 'OPTIONS') {
            if (blocked) return
            res.writeHead(200)
            res.end()
            return
        }
        function parseCookie() {
            if (!req.headers.cookie) { return {} } 
            const cookies = {}
            for (const cookie of req.headers.cookie.split(';')) {
                cookies[cookie.split('=')[0]] = cookie.split('=')[1]
            }
            return cookies
        }
        for (const event of domains[service].urls) {
            if ((await parseParams(url.pathname, event.url) || url.pathname == event.url) && req.method.toUpperCase() == event.method.toUpperCase()) {
                let ctx = {
                    res: {
                        status: async a => status = a,
                        json: async a => {
                            if (blocked) return
                            res.writeHead(status, { "Content-Type": "application/json" })
                            res.end(JSON.stringify(a))
                        },
                        html: async a => {
                            if (blocked) return
                            res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
                            res.end(a)
                        },
                        text: async a => {
                            if (blocked) return
                            res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
                            res.end(a)
                        },
                        empty: async () => {
                            if (blocked) return
                            if (errP?.[status.toString()] || defaults?.errorPages?.[status.toString()]) {
                                const ststatus = status.toString()
                                res.writeHead(308, {"Content-Type": "text/html", "Location": errP?.[ststatus] || defaults?.errorPages?.[ststatus]})
                                return res.end()
                            }
                            res.writeHead(status, { "Content-Type": "text/html" })
                            res.end()
                        },
                        raw: async a => {
                            res.writeHead(status, {})
                            res.end(a)
                        },
                        res: res
                    },
                    body: {
                        json: async () => new Promise((resolve) => {
                            let body = ""
                            req.on('data', chunk => body += chunk )
                            req.on('end', () => {
                                try {
                                    resolve(JSON.parse(body))
                                } catch {
                                    resolve(null)
                                }
                            })
                        }),
                        url: async () => new URLSearchParams(url.search),
                        formdata: async () => new Promise((resolve, reject) => {
                            const form = formidable({ multiples: true })
                            form.parse(req, (err, fields, files) => {
                                if (err) return reject(err)
                                for (let k of Object.keys(fields)) {
                                    if (Array.isArray(fields[k]) && fields[k].length == 1) {
                                        fields[k] = fields[k][0]
                                    }
                                }
                                resolve({ fields, files })
                            })
                        }),
                        text: async () => new Promise(resolve => {
                            let body = ""
                            req.on('data', chunk => body += chunk)
                            req.on('end', () => {
                                resolve(body)
                            })
                        }),
                        params: await parseParams(url.pathname, event.url)
                    },
                    headers: {
                        sent: res.headersSent,
                        get: req.headers,
                        set: (k, v) => res.setHeader(k, v)
                    },
                    req: {
                        on: req.on,
                        ip: ip,
                        url: req.url,
                        cookie: parseCookie(),
                        setCookie: (name="Not set", value="Not set", path="/", expires=false, httpOnly=false, secure=true, sameSite="Lax") => {
                            if (res.headersSent) return false
                            let expirest = ''
							if (typeof expires == 'number') {
                                expirest = '; Max-Age=' + expires
                            } else if (expires instanceof Date) {
                            	expirest = "; Expires=" + expires.toUTCString()
                            }
                            res.setHeader("Set-Cookie", `${name}=${value}; Path=${path}${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}; SameSite=${sameSite}${expirest}`)
                            return true
                        }
                    }
                }
                pluginmanager.on("post-processing", e => {
                    if (!e) return
                    ctx = {...e, ...ctx}
                })
                pluginmanager.hook("post-processing", false)
                if (["GET", "HEAD"].includes(req.method.toUpperCase())) {
                    delete ctx.body.json
                    delete ctx.body.formdata
                    delete ctx.body.text
                }
                try {
                    let res = await event.callback(ctx)
                    if (res != true || res != 1) {
                        return
                    }
                } catch (e) {
                    logger.error('', e.stack)
                    if (blocked) return
                    pluginmanager.hook("skip-request", { reason: 'Internal error' })
                    res.writeHead(308, {"Content-Type": "text/html", "Location": errP?.["500"] || defaults?.errorPages?.["500"]})
                    return res.end()
                }
            }
        }
    }
   
    if (domains[service]?.settings?.alias) {
        HTTPProxy(req, res, domains[service].settings.alias, ip)
        return
    }
    
    if (req.method != 'GET') {
        if (blocked) return
        pluginmanager.hook("skip-request", { reason: 'methodNotAllowed' })
        res.writeHead(308, {"Content-Type": "text/html", "Location": errP?.["405"] || defaults?.errorPages?.["405"]})
        res.end()
        return
    }
    if (!await exists(defaultDir)) {
        if (blocked) return
        console.log("sadd")
        pluginmanager.hook("skip-request", { reason: 'notFound' })
        res.writeHead(308, {"Content-Type": "text/html", "Location": errP?.["404"] || defaults?.errorPages?.["404"]})
        return res.end()
    }
    const _writeHead = res.writeHead.bind(res)
    const _end = res.end.bind(res)
    const recordname = `${service}${url.pathname}[${req.method}]`
    const root = `${defaultDir}/${service}`
    if (req.headers['cache-control'] != 'no-cache' && await redis.exists(recordname)) {
        const cachedres = JSON.parse(await redis.get(recordname)) 
        res.writeHead(cachedres.status, cachedres.headers)
        if (cachedres.data?.type == "Buffer" && cachedres.data?.data) {
            cachedres.data = Buffer.from(cachedres.data.data)
        }
        res.end(cachedres.data)
        return
    }
    res.writeHead = async (status, headers) => {
        const data = { status: status, headers: headers }
        await redis.set(recordname, JSON.stringify(data), { EX: 7200 })
    }
    res.end = async body => {
        const isText = /json|text|javascript|svg|xml/.test(res.getHeaders()['content-type'] || '')
        let data
        if (!await redis.exists(recordname)) {
            data = { status: status, headers: {} }
        } else {
            data = JSON.parse(await redis.get(recordname))
        }
        
        if (isText && body && Buffer.byteLength(body) > 1024) {
            try {
                const compressed = await gzip(body)
                if (compressed.length < Buffer.byteLength(body)) {
                    data.headers['Content-Encoding'] = 'gzip'
                    body = compressed
                }
            } catch (e) {
                logger.error('Gzip error', e)
            }
        }
        _writeHead(data.status, data.headers)
        _end(body)
        if (!body) { return }
        const MAX_SIZE = 3 * 1024 * 1024
        if (Buffer.byteLength(body, 'utf8') > MAX_SIZE) {
            await redis.del(recordname)
            return
        }
        data.data = body
        await redis.set(recordname, JSON.stringify(data), { EX: 7200 })
    }
	{
        const path = url.pathname.replace(/^\/|\/$/g, '')
        if (domains[service]?.settings && path === domains[service].settings.backend) {
            if (blocked) return
            pluginmanager.hook("skip-request", { reason: 'Forbidden' })
            res.writeHead(308, {"Content-Type": "text/html", "Location": errP?.["403"] || defaults?.errorPages?.["403"]})
            return res.end()
        }
    }
    const cleanUrl = pathm.normalize(url.pathname)
    const ext  = cleanUrl.split('/').pop().split('.').pop() || ''
    const path = cleanUrl.replace(new RegExp(`\\.${ext}$`), '')
    const realPath = `${defaultDir}/${service}${path}${ext ? `.${ext}` : ""}`
    
    if (!await exists(realPath) || (Array.from(realPath).pop() == "/" && !await exists(realPath + "index.html"))) {
        if (blocked) return
        pluginmanager.hook("skip-request", { reason: 'notFound' })
        res.writeHead(308, {"Content-Type": "text/html", "Location": errP?.["404"] || defaults?.errorPages?.["404"]})
        return res.end()
    }
    
    const stat = await fs.stat(realPath)
    
    if (stat.isDirectory()) {
        let path = cleanUrl.replace(/^\/|\/$/g, '')
        if (blocked) return
        if (cleanUrl.split("/").length > 0) {
            res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"})
            res.end(await fs.readFile(`${defaultDir}/${service}/${path}/index.html`))
        } else {
            res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"})
            res.end(await fs.readFile(`${defaultDir}/${service}/index.html`))
        }
    } else if (stat.isFile()) {
        var page = ""
        var noone = 'text/plain; charset=utf-8'
        
        if ([`${root}/builder.js`, `${root}/logger.js`, `${root}/params.conf`, `${root}/redis.js`].includes(realPath) ||
            realPath.split("/").pop().startsWith('.')) {
            if (blocked) return
            pluginmanager.hook("skip-request", { reason: 'forbidden' })
            res.writeHead(308 , {"Content-Type": "text/html", "Location": errP?.["403"] || defaults?.errorPages?.["403"]})
            return res.end()
        }
        
        if (["video", "audio"].includes(mime[ext].split("/")[0])) {
            if (blocked) return
            res.writeHead = _writeHead
            res.end = _end
            await mediaRange(ext, realPath, req, res)
            return
        }

        if (stat.size > 10 * 1024 * 1024) {
            res.writeHead(200, {"Content-Type": mime[ext] || noone})
            const stream = fss.createReadStream(realPath)
            stream.pipe(res)
            res.on('close', () => {
                if (!res.writableEnded) {
                    stream.destroy()
                }
            })
            return
        } else {
            page = await fs.readFile(realPath)
        }

        res.writeHead(status, {"Content-Type": mime[ext] || noone})
        res.end(page)
    }
}

const webHttpServer = http.createServer(handle)

const websocketHandler = (ws, req) => {
    req.url = new URL(`ws://${req.headers.host}${req.url}`)
    const domain = domains[req.url.hostname]
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress
    const country = req.headers["cf-ipcountry"]
    {
        const ipString = ip ? `(${ip}${country ? `[${country}]` : ''})` : ''
        logger.info(`[${req.url.hostname}][${req.method}] ${req.url} ${ipString} ${req.headers['user-agent'] || ""}`)
    }
    if (domain?.settings?.alias) {
        const alias = domain.settings.alias
        const url = new URL(alias.url)
        const clientHeaders = { ...req.headers }
        delete clientHeaders.host
        delete clientHeaders.upgrade
        delete clientHeaders.connection
        const target = new WebSocket(`ws://${url.hostname}/${req.url}`, {
            headers: clientHeaders
        })
        ws.on('message', (data, isBinary) => {
            if (target.readyState === WebSocket.OPEN) {
                target.send(data, { binary: isBinary })
            }
        })

        target.on('message', (data, isBinary) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data, { binary: isBinary })
            }
        })

        target.on('open', e => {
            // console.log('Прокси: Соединение с целью открыто')
        })

        ws.on('close', () => target.close())
        target.on('close', () => ws.close())

        ws.on('error', (err) => {})
        ws.on('error', (err) => {})
        return
    }
    if (!domain || !domain?.ws || domain.ws.length == 0) {
        ws.terminate()
        return
    }
    req.response = (data) => {
        if (typeof data == 'object') {
            data = JSON.stringify(data)
        }
        ws.send(data)
    }
    let flag = true
    for (let route of domain.ws) {
        if (route.url == req.url.pathname) {
            flag = false
            ws.info = {
                url: req.url,
                host: req.headers.host,
                ip: ip
            }
            route.callback.onopen(req)
            ws.on("message", message => {
                route.callback.onmessage(req, message)
            })
            ws.on("close", route.callback.onclose)
            break
        }
    }
    if (flag) {
        ws.close(1008, "Route not found")
        return
    }
}

const socketWsServer = new WebSocketServer({ server: webHttpServer })
socketWsServer.on("connection", websocketHandler)
pluginmanager.hook("ws-listen")
let defaultCert

webHttpServer.listen(defaults.port || 3003, defaults.address || "0.0.0.0", () => logger.info('[WEB] HTTP server running on :' + defaults.port || 3003))
pluginmanager.hook("web-http-listen")
if (defaults.https == true) {
    const websrv = https.createServer({
        SNICallback: async (service, cb) => {
            const cert = domains?.[service]?.settings?.cert
            const root = `${defaultDir}/${service}`
            if (domains?.[service] && domains?.[service]?.certificate) {
                cb(null, domains?.[service]?.certificate)
            } else if (cert?.key && cert?.crt && await exists(`${root}/${cert?.key}`) && await exists(`${root}/${cert?.crt}`)) {
                const certif = tls.createSecureContext({
                    key: await fs.readFile(`${root}/${cert?.key}`),
                    cert: await fs.readFile(`${root}/${cert?.crt}`)
                })
                if (domains?.[service]) domains[service].certificate = certif
                cb(null, certif)
            } else if (defaultCert) {
                cb(null, defaultCert)
            } else if (await exists("./cert/server.key") && await exists("./cert/server.crt")) {
                const certif = tls.createSecureContext({
                    key: await fs.readFile("./cert/server.key"),
                    cert: await fs.readFile("./cert/server.crt")
                })
                defaultCert = certif
                cb(null, certif)
            } else {
                cb(new Error("No certificate"), null)
            }
        }
    }, handle)
    websrv.listen(defaults.httpsPort || 3004, defaults.address || "0.0.0.0", () => logger.info('[WEB] HTTPS server running on :' + defaults.httpsPort || 3004))
	pluginmanager.hook("web-https-listen")
    const socketWsServer = new WebSocketServer({ server: websrv })
    socketWsServer.on("connection", websocketHandler)
	pluginmanager.hook("wss-listen")
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

rl.on('line', async input => {
    const command = input.trim().toLowerCase()

    if (command === 'upd') {
        defaults = await exists('./defaults.conf') ? JSON.parse(await fs.readFile('./defaults.conf')) : {}
        defaultCert = undefined
        logger.info("[upd] Updating variables successfully")
    } else if (command === "flush") {
        redis.flushDB()
    }

    rl.prompt()
})

let analyticsCb = null

export async function signals(signaltype, cb) {
    if (signaltype == 'updatevars') {
        defaults = await exists('./defaults.conf') ? JSON.parse(await fs.readFile('./defaults.conf')) : {}
        return true
    } else if (signaltype == 'reganalytics') {
        if (!analyticsCb) {
            analyticsCb = cb
        }
    }
}

if (defaults?.errorPages?.auto) {
    const dir = defaults?.errorPages?.auto
    if (await exists(dir)) {
        for (const content of await fs.readdir(dir, { withFileTypes: true })) {
            if (isNaN(content.name)) continue
            defaults.errorPages[content.name] = `${dir}/${content.name}`
        }
    }
}