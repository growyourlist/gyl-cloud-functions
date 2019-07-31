const dynamodb = require('dynopromise-client')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

let dbConfig = null
if (process.env.TEST_AWS_REGION && process.env.TEST_AWS_DB_ENDPOINT) {
	dbConfig = {
		region: process.env.TEST_AWS_REGION,
		endpoint: process.env.TEST_AWS_DB_ENDPOINT,
	}
}

const db = dbConfig ? dynamodb(dbConfig) : dynamodb()

const tagPattern = /^add-tag_([a-zA-Z0-9_\-]{1,248})$/

/**
 * Reads the SNS message or rejects.
 */
const readMessageData = event => new Promise((resolve, reject) => {
	try {
		return resolve(JSON.parse(event.Records[0].Sns.Message.trim()))
	}
	catch (err) {
		return reject(err)
	}
})

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberStatusByEmail = email => db.query({
	TableName: `${dbTablePrefix}Subscribers`,
	IndexName: 'EmailToStatusIndex',
	KeyConditionExpression: 'email = :email',
	ExpressionAttributeValues: {
		':email': email
	},
})
.then(result => {
	if (!result || !result.Count) {
		// Subscriber does not exist anymore.
		return null
	}
	return result.Items[0]
})

/**
 * Adds a new tag to the given list of tags.
 */
const addTag = (tagName, tags) => {
	if (!tags || !tags.length) {
		return [tagName]
	}
	if (tags.indexOf(tagName) >= 0) {
		return tags
	}
	return tags.concat([tagName])
}

/**
 * Updates the subscriber based on the triggered interaction.
 */
const doTrigger = (email, trigger, interaction) => {
	return getSubscriberStatusByEmail(email)
	.then(subscriberStatus => {
		if (!subscriberStatus) {
			return
		}

		const now = Date.now()
		const updateDef = {
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriberStatus.subscriberId },
			UpdateExpression: 'set #lastOpenOrClick = :lastOpenOrClick',
			ExpressionAttributeNames: { '#lastOpenOrClick': 'lastOpenOrClick' },
			ExpressionAttributeValues: { ':lastOpenOrClick': now },
		}
		const matches = trigger && trigger.match(tagPattern)
		if (matches) {
			const tag = matches[1]
			updateDef.UpdateExpression += ', #tags = :tags'
			updateDef.ExpressionAttributeNames['#tags'] = 'tags'
			updateDef.ExpressionAttributeValues[':tags'] = addTag('active', 
				addTag(tag, subscriberStatus.tags)
			)
			if (tag === 'main-active') {
				updateDef.UpdateExpression += ', #confirmed = :confirmed'
				updateDef.ExpressionAttributeNames['#confirmed'] = 'confirmed'
				updateDef.ExpressionAttributeValues[':confirmed'] = (
					new Date()
				).toISOString()
			}
		}
		if (interaction === 'click') {
			updateDef.UpdateExpression += ', #lastClick = :lastClick'
			updateDef.ExpressionAttributeNames['#lastClick'] = 'lastClick'
			updateDef.ExpressionAttributeValues[':lastClick'] = now
		}
		if (interaction === 'open') {
			updateDef.UpdateExpression += ', #lastOpen = :lastOpen'
			updateDef.ExpressionAttributeNames['#lastOpen'] = 'lastOpen'
			updateDef.ExpressionAttributeValues[':lastOpen'] = now
		}
		return db.update(updateDef)
	})
}

const getTrigger = (tags, interaction) => {
	if (!tags || !Object.keys(tags).length) {
		return null
	}
	if (interaction === 'click' && tags['Interaction-Click']) {
		return tags['Interaction-Click'][0]
	}
	else if (interaction === 'open' && tags['Interaction-Open']) {
		return tags['Interaction-Open'][0]
	}
	return null
}

const updateQueueItem = (tags, interaction) => {
	if ((typeof tags !== 'object') || !Array.isArray(tags['DateStamp']) ||
	!Array.isArray(tags['RunAtModified'])) {
		return Promise.resolve()
	}
	const dateStampType = typeof tags['DateStamp'][0]
	const runAtModifiedType = typeof tags['RunAtModified'][0]
	if (!(dateStampType === runAtModifiedType && dateStampType === 'string' &&
			/\d{4}-\d{2}-\d{2}/.test(tags['DateStamp'][0]) &&
			/\d+\_\d+/.test(tags['RunAtModified'][0]))) {
		return Promise.resolve()
	}
	if (!(interaction === 'click' || interaction === 'open')) {
		return Promise.resolve()
	}
	const nowInSeconds = Date.now()
	return db.update({
		TableName: `${dbTablePrefix}Queue`,
		Key: {
			queuePlacement: tags['DateStamp'][0],
			runAtModified: tags['RunAtModified'][0].replace('_', '.'),
		},
		UpdateExpression: 'set #clickOrOpen = :nowInSeconds',
		ConditionExpression: 'attribute_exists(#queuePlacement) and '
		+ 'attribute_exists(#runAtModified)',
		ExpressionAttributeNames: {
			'#clickOrOpen': interaction,
			'#queuePlacement': 'queuePlacement',
			'#runAtModified': 'runAtModified',
		},
		ExpressionAttributeValues: {
			':nowInSeconds': nowInSeconds,
		}
	})
	.catch(err => {
		if (err.name === 'ConditionalCheckFailedException') {
			// The queue item does not exist, ignore
			return Promise.resolve()
		}
		throw err
	})
}

exports.handler = (event, context, callback) => {
	readMessageData(event)
	.then(message => {
		const interaction = message.eventType.toLowerCase() // E.g. Open or Click
		const email = message.mail.destination[0]
		const trigger = getTrigger(message.mail.tags, interaction)
		return Promise.all([
			doTrigger(email, trigger, interaction),
			updateQueueItem(message.mail.tags, interaction)
		])
		.then(() => callback())
	})
	.catch(err => {
		console.log(`Error handling email event: ${err.message}`)
		callback()
	})
}
