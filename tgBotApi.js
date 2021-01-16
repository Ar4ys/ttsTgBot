const TelegramBot = require('node-telegram-bot-api')
const got = require("got")
const ffmpeg = require('fluent-ffmpeg')
const { Readable } = require("stream")
const fs = require("fs/promises")
require("colors")

const token = process.env.TOKEN
const bot = new TelegramBot(token)

bot.startPolling()
	.then(logBotStarted)
	.catch(logError)

process.on("uncaughtException", async e => {
	await logError(e)
	const isClosed = await bot.close()
	if (isClosed)
		return await logClosing()

	await logError(new Error("Cannot stop bot"))
	await logClosing()
})

/**	
 * @param key: chat.id
 * @param value: {
 * 	isProcessing: boolean
 * 	timeoutTo: number
 * }
 */
const sessions = new Map()

function useSession(chatId) {
	if (!sessions.has(chatId))
		sessions.set(chatId, { isProcessing: false, timeoutTo: 0 })

	return [
		{ ...sessions.get(chatId) },
		newSession => sessions.set(chatId, {
			...sessions.get(chatId),
			...newSession
		})
	]
}

function secondsToWait(to) {
	return Math.floor((to - Date.now()) / 1000)
}

bot.on("text", async msg => {
	const { text, chat } = msg
	const [ { isProcessing, timeoutTo }, setSession ] = useSession(chat.id)
	
	logIncomingMsg(msg)

	if (/^\/start$/.test(text)) {
		await sendVoice(chat, await prepareAudioForVoice("./start.wav"))
		return bot.sendMessage(chat.id, "Hello, I am GLaDOS. If you want to hear me, just send me text (only English)")
	}

	if (isProcessing)
		return bot.sendMessage(
			chat.id,
			"Please wait while the previous voice is being generated"
		)
	else if (timeoutTo > Date.now())
		return bot.sendMessage(
			chat.id,
			`Please wait for ${secondsToWait(timeoutTo)} seconds`
		)

	setSession({ isProcessing: true })
	bot.sendMessage(chat.id, "Generating voice...")
	try {
		sendVoice(chat, await generateVoiceBuffer(text))
		setSession({ isProcessing: false, timeoutTo: Date.now() + 60 * 1000 })
	} catch(e) {
		setSession({ isProcessing: false })
		console.error("[TTS] Reply With Voice", e)
		bot.sendMessage(chat.id, "Ooops, something went wrong. Try again")
	}
})

async function sendVoice(chat, voice) {
	const message = await bot.sendVoice(chat.id, voice, {}, { contentType: 'audio/ogg' })
	logSendVoice(message)
	return message
}

async function generateVoiceBuffer(text) {
	const voiceStream = await getVoiceAudioStream(text)
	return await prepareAudioForVoice(voiceStream)
}

async function prepareAudioForVoice(stream) {
	const oggStream = convertToOggStream(stream, logError)
	return await convertToBuffer(oggStream)
}

async function getVoiceAudioStream(text, beforeRetry = () => {}) {
	const response = await got.post("https://api.15.ai/app/getAudioFile", {
		json: {
			text,
			character: "GLaDOS",
			emotion: "Contextual",
			use_diagonal: true
		},
		// hooks: {
		// 	beforeRetry: [ beforeRetry ]
		// },
		// retry: 5
	})
	
	return Readable.from(response.rawBody, { autoDestroy: true })
}

function convertToOggStream(audioStream, onError = () => {}, onEnd = () => {}) {
	return ffmpeg(audioStream)
			.toFormat('ogg')
			.audioCodec("libopus")
			.on('error', onError)
			.on('end', onEnd)
			.pipe()
}

async function convertToBuffer(stream) {
	let buffer = Buffer.alloc(0)
	for await (const chunk of stream)
		buffer = Buffer.concat([buffer, chunk])
	return buffer
}

async function logIncomingMsg({ chat, user, text, date }) {
	const { title } = chat
	const { username, first_name, last_name } = user ?? chat
	const isPrivate =  chat.type === "private"
	
	const currentTime = new Date().toTimeString().split(" ")[0]
	const messageDate = new Date(date*1000).toISOString().split(".")[0]
	const logDate = new Date().toISOString().split(".")[0].split("T")[0]


	console.log(
		`[${currentTime}][NEW MESSAGE]`.green, "\n",
		"Sender:".green, first_name, last_name ?? "", `(${username ?? user.id})`, "\n",
		"Chat:".green, isPrivate ? "private" : `${title} (${chat.id})`, "\n",
		"Date:".green, messageDate, "\n",
		"Content:".green, text.blue, "\n"
	)

	await fs.appendFile(`./logs/log-${logDate}.txt`,
		`[${currentTime}][NEW MESSAGE]\n` +
		`Sender: ${first_name} ${last_name ?? ""} (${username ?? user.id})\n` +
		`Chat: ${isPrivate ? "private" : `${title} (${chat.id})`}\n` +
		`Date: ${messageDate}\n` +
		`Content: ${text}\n\n`
	)
}

async function logSendVoice({ chat, date }) {
	const { username, first_name, last_name, id } = chat
	const isPrivate = chat.type === "private"
	const title = isPrivate
		? `${first_name} ${last_name ?? ""} (${username ?? id})`
		: `${chat.title} (${id})`

	const currentTime = new Date().toTimeString().split(" ")[0]
	const messageDate = new Date(date*1000).toISOString().split(".")[0]
	const logDate = new Date().toISOString().split(".")[0].split("T")[0]


	console.log(
		`[${currentTime}][SEND VOICE]`.green, "\n",
		"Chat:".green, title, "\n",
		"Date:".green, messageDate, "\n"
	)

	await fs.appendFile(`./logs/log-${logDate}.txt`,
		`[${currentTime}][SEND VOICE]\n` +
		`Chat: ${title} \n` +
		`Date: ${messageDate} \n\n`
	)
}

async function logBotStarted() {
	const currentTime = new Date().toTimeString().split(" ")[0]
	const logDate = new Date().toISOString().split(".")[0].split("T")[0]

	console.log(
		`[${currentTime}]`.green,
		"Bot Started".blue, "\n",
	)

	await fs.appendFile(`./logs/log-${logDate}.txt`,
		`[${currentTime}] Bot Started\n\n`
	)
}

async function logClosing() {
	const currentTime = new Date().toTimeString().split(" ")[0]
	const logDate = new Date().toISOString().split(".")[0].split("T")[0]

	console.log(
		`[${currentTime}]`.green,
		"Closing...".blue, "\n",
	)

	await fs.appendFile(`./logs/log-${logDate}.txt`,
		`[${currentTime}] Closing...\n\n`
	)
}

async function logError(error) {
	const currentTime = new Date().toTimeString().split(" ")[0]
	const logDate = new Date().toISOString().split(".")[0].split("T")[0]
	console.error(
		`[${currentTime}]`.green + "[ERROR]".red, "\n", error
	)

	await fs.appendFile(
		`./logs/log-${logDate}.txt`,
		`[${currentTime}][ERROR]\n${error}\n\n`
	)	
}