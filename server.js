import pluginmanager from './pluginmanager.js'
import logger from './logger.js'
import process from 'process'
import fs from 'fs/promises'
import pathh from 'path'

pluginmanager.hook("loading-started")
const startWith = new Date().getTime() / 1000
async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

const attempts = {}
let workers = []

async function pcall(path) {
    if (!attempts[path]) attempts[path] = 0

    while (attempts[path] <= 10) {
        try {
			pluginmanager.hook("loading-save-call", path)
            return await import(path)
        } catch (e) {
			pluginmanager.hook("loading-save-call-error", path, e)
            logger.error(`[${path.split('/').pop()}][${attempts[path]}] ${e.stack}`)
            attempts[path]++
        }
    }
}

fs.r = fs.readFile
fs.readFile = async (...args) => {
    try {
        return await fs.r(...args)
    } catch {
        return undefined
    }
}

async function git(username, repo, domain="uasalt.org", githubToken) {
    repo = `${repo}.${domain}`
    let headers = {}
    if (githubToken) {
        headers = {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
    }
    if (await exists(`./web/${repo}`)) {
    	if (!await exists(`./web/${repo}/params.conf`)) { return }
        const conf = JSON.parse(await fs.readFile(`./web/${repo}/params.conf`) || "{}")
        if (!conf.backend) {
    		logger.info(`[${repo}] Loaded only frontend`)
            return
        }
        logger.info(`[${repo}] Running`)
        pcall(`./web/${repo}/${conf.backend}`)
        return
    }
	pluginmanager.hook("github-download")
    logger.info(`[${repo}] Downloading started`)
    repo = repo.replaceAll('/', '-')
    const root = await fetch(`https://api.github.com/repos/${username}/${repo}/contents/src`, { headers })
    await fs.mkdir(`./web/${repo}`, { recursive: true })
	async function scan(dir) {
        if (dir.status == 404) {
        	return
        }
		for (const path of dir) {
            const originalPath = path.path
            path.path = path.path.replace("src", `./web/${repo}`)
            if (path.type == 'file') {
                const fileF = await fetch(path.download_url, { headers })
                await fs.writeFile(path.path, Buffer.from(await fileF.arrayBuffer()))
            } else if (path.type == 'dir') {
                await fs.mkdir(path.path, { recursive: true })
                const sdir = await fetch(`https://api.github.com/repos/${username}/${repo}/contents/${originalPath}`, { headers })
                await scan(await sdir.json())
            }
        }
    }
    await scan(await root.json())
    logger.info(`[${repo}] Download successfully`)
    if (await exists(`./web/${repo}/params.conf`)) {
        const conf = JSON.parse(await fs.readFile(`./web/${repo}/params.conf`) || "{}")
        await fs.symlink(pathh.resolve('./builder.js'), `./web/${repo}/builder.js`)
        await fs.symlink(pathh.resolve('./logger.js'), `./web/${repo}/logger.js`)
        pcall(`./web/${repo}/${conf.backend}`)
    } else {
    	logger.info(`[${repo}] Loaded only frontend`)
    }
}

process.on("SIGINT", async () => {
	pluginmanager.hook("signal-sigint")
	logger.info(" Safe stop completed")
	process.exit(0)
})

async function init() {
    if (await exists('./web')) {
        for (const content of await fs.readdir("./web", { withFileTypes: true })) {
            if (content.isFile()) { continue }
            if (!await exists(`./web/${content.name}/params.conf`)) { continue }
            const conf = JSON.parse(await fs.readFile(`./web/${content.name}/params.conf`))
            if (!await exists(`./web/${content.name}/builder.js`)) {
                await fs.symlink(pathh.resolve('./builder.js'), `./web/${content.name}/builder.js`)
            }
            if (!await exists(`./web/${content.name}/logger.js`)) {
                await fs.symlink(pathh.resolve('./logger.js'), `./web/${content.name}/logger.js`)
            }
            if (!await exists(`./web/${content.name}/redis.js`)) {
                await fs.symlink(pathh.resolve('./redis.js'), `./web/${content.name}/redis.js`)
            }
            if (!conf.backend) {
                await eval(`(async () => {
                    const { default: builder } = await import("./builder.js");
                    builder("${content.name}")
                })()`)
            }

            if (conf.repository) {
                await git(conf.repository.author, conf.repository.name, undefined, conf.repository.token)
            } else if (await exists(`./web/${content.name}/${conf.backend}`)) {
                await pcall(`./web/${content.name}/${conf.backend}`)
                logger.info(`[${content.name}] Running`)
            } else {
                logger.info(`[${content.name}] Skipped`)
            }
        }
    }
}

await pcall('./builder.js')
await init()
await pcall('./analytics.js')

logger.info(` Server started in ${(new Date().getTime() / 1000 - startWith).toFixed(2)} sec.`)
console.log("Done")
pluginmanager.hook("loading-end")