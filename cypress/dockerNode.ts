/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* eslint-disable no-console */
import Docker from 'dockerode'
import path from 'path'
import waitOn from 'wait-on'

import pkg from '../package.json'

const APP_PATH = path.resolve(__dirname, '../')
const APP_NAME = pkg.name

const CONTAINER_NAME = 'nextcloud-cypress-tests-' + APP_NAME
const SERVER_IMAGE = 'ghcr.io/nextcloud/continuous-integration-shallow-server'

export const docker = new Docker()

/**
 * Start the testing container
 *
 * @param branch the current git branch
 */
export const startNextcloud = async function(branch = 'master'): Promise<string> {
	try {
		// Pulling images
		console.log('Pulling images... ⏳')
		await new Promise((resolve, reject) => docker.pull(SERVER_IMAGE, (_err, stream: NodeJS.ReadableStream) => {
			const onFinished = function(err: Error | null) {
				if (!err) {
					return resolve(true)
				}
				reject(err)
			}
			// https://github.com/apocas/dockerode/issues/357
			docker.modem.followProgress(stream, onFinished)
		}))
		console.log('└─ Done')

		// Getting latest image
		console.log('\nChecking running containers... 🔍')
		const localImage = await docker.listImages({ filters: `{"reference": ["${SERVER_IMAGE}"]}` })

		// Remove old container if exists and not initialized by us
		try {
			const oldContainer = docker.getContainer(CONTAINER_NAME)
			const oldContainerData = await oldContainer.inspect()
			if (oldContainerData.State.Running) {
				console.log('├─ Existing running container found')
				if (localImage[0].Id !== oldContainerData.Image) {
					console.log('└─ But running container is outdated, replacing...')
				} else {
					// Get container's IP
					console.log('├─ Reusing that container')
					const ip = await getContainerIP(oldContainer)
					return ip
				}
			} else {
				console.log('└─ None found!')
			}
			// Forcing any remnants to be removed just in case
			await oldContainer.remove({ force: true })
		} catch (error) {
			console.log('└─ None found!')
		}

		// Starting container
		console.log('\nStarting Nextcloud container... 🚀')
		console.log(`├─ Using branch '${branch}'`)
		console.log(`├─ And binding app '${APP_NAME}' from '${APP_PATH}'`)
		const container = await docker.createContainer({
			Image: SERVER_IMAGE,
			name: CONTAINER_NAME,
			HostConfig: {
				Binds: [`${APP_PATH}:/var/www/html/apps/${APP_NAME}`],
			},
			Env: [
				`BRANCH=${branch}`,
			],
		})
		await container.start()

		// Get container's IP
		const ip = await getContainerIP(container)

		console.log(`├─ Nextcloud container's IP is ${ip} 🌏`)
		return ip
	} catch (err) {
		console.log('└─ Unable to start the container 🛑')
		console.log(err)
		stopNextcloud()
		throw new Error('Unable to start the container')
	}
}

/**
 * Configure Nextcloud
 *
 * @param branch
 */
export const configureNextcloud = async function(branch = 'master') {
	console.log('\nConfiguring nextcloud...')
	const container = docker.getContainer(CONTAINER_NAME)
	await runExec(container, ['php', 'occ', '--version'], true)

	// Clone the viewer app
	await runExec(container, ['git', 'clone', '--depth', '1', '--branch', branch, 'https://github.com/nextcloud/viewer.git', '/var/www/html/apps/viewer'], true)

	// Be consistent for screenshots
	await runExec(container, ['php', 'occ', 'config:system:set', 'default_language', '--value', 'en'], true)
	await runExec(container, ['php', 'occ', 'config:system:set', 'force_language', '--value', 'en'], true)
	await runExec(container, ['php', 'occ', 'config:system:set', 'default_locale', '--value', 'en_US'], true)
	await runExec(container, ['php', 'occ', 'config:system:set', 'force_locale', '--value', 'en_US'], true)
	await runExec(container, ['php', 'occ', 'config:system:set', 'enforce_theme', '--value', 'light'], true)

	// Enable the app and give status
	await runExec(container, ['php', 'occ', 'app:enable', '--force', 'viewer'], true)
	await runExec(container, ['php', 'occ', 'app:enable', 'groupfolders', '--force'], true)
	await runExec(container, ['php', 'occ', 'app:enable', 'files_trashbin', '--force'], true)
	// await runExec(container, ['php', 'occ', 'app:list'], true)

	console.log('└─ Nextcloud is now ready to use 🎉')
}

/**
 * Force stop the testing nextcloud container
 */
export const stopNextcloud = async function() {
	try {
		const container = docker.getContainer(CONTAINER_NAME)
		console.log('Stopping Nextcloud container...')
		container.remove({ force: true })
		console.log('└─ Nextcloud container removed 🥀')
	} catch (err) {
		console.log(err)
	}
}

/**
 * Get the testing container's IP address
 *
 * @param container the container to get the ip from
 */
export const getContainerIP = async function(
	container: Docker.Container = docker.getContainer(CONTAINER_NAME),
): Promise<string> {
	let ip = ''
	let tries = 0
	while (ip === '' && tries < 10) {
		tries++

		await container.inspect(function(err, data) {
			if (err) {
				throw err
			}
			ip = data?.NetworkSettings?.IPAddress || ''
		})

		if (ip !== '') {
			break
		}

		await sleep(1000 * tries)
	}

	return ip
}

/**
 * Would be simpler to start the container from cypress.config.ts,
 * but when checking out different branches, it can take a few seconds
 * Until we can properly configure the baseUrl retry intervals,
 * We need to make sure the server is already running before cypress
 *
 * @param {string} ip the ip to wait for
 * @see https://github.com/cypress-io/cypress/issues/22676
 */
export const waitOnNextcloud = async function(ip: string) {
	console.log('├─ Waiting for Nextcloud to be ready... ⏳')
	await waitOn({ resources: [`http://${ip}/index.php`] })
	console.log('└─ Done')
}

const runExec = async function(
	container: Docker.Container,
	command: string[],
	verbose = false,
	user = 'www-data',
) {
	const exec = await container.exec({
		Cmd: command,
		AttachStdout: true,
		AttachStderr: true,
		User: user,
	})

	return new Promise((resolve, reject) => {
		exec.start({}, (err, stream) => {
			if (err) {
				reject(err)
			}
			if (stream) {
				stream.setEncoding('utf-8')
				stream.on('data', str => {
					if (verbose && str.trim() !== '') {
						console.log(`├─ ${str.trim().replace(/\n/gi, '\n├─ ')}`)
					}
				})
				stream.on('end', resolve)
			}
		})
	})
}

const sleep = function(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
