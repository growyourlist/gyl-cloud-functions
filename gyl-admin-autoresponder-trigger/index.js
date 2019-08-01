const dynamodb = require('dynopromise-client')
const Joi = require('joi')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
let dbConfig = null
if (process.env.TEST_AWS_REGION && process.env.TEST_AWS_DB_ENDPOINT) {
	dbConfig = {
		region: process.env.TEST_AWS_REGION,
		endpoint: process.env.TEST_AWS_DB_ENDPOINT,
	}
}

const db = dbConfig ? dynamodb(dbConfig) : dynamodb()

// Schema to validate incoming add subscriber requests from userland.
const triggerSchema = Joi.object().keys({
	email: Joi.string().email(),
	subscriberId: Joi.string().guid(),
})

const getSubscriberById = subscriberId => db.get({
	TableName: `${dbTablePrefix}Subscribers`,
	Key: { subscriberId }
})
.then(res => res.Item || null)

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getFullSubscriber = subscriberData => {
	if (subscriberData.subscriberId) {
		return getSubscriberById(subscriberData.subscriberId)
	}
	return db.query({
		TableName: `${dbTablePrefix}Subscribers`,
		IndexName: 'EmailToStatusIndex',
		KeyConditionExpression: 'email = :email',
		ExpressionAttributeValues: {
			':email': subscriberData.email
		},
	})
	.then(results => {
		if (!results.Count) {
			return null
		}
		return getSubscriberById(results.Items[0].subscriberId)
	})
}

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @return {Object}
 */
const response = (statusCode, body = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'text/plain; charset=utf-8'
		},
		body: body,
	}
}

const getSubscriberData = body => {
	try {
		return JSON.parse(body)
	}
	catch (ex) {
		return null
	}
}

const runTrigger = (params, subscriber) => {
	if (params.triggerType === 'autoresponder' && params.triggerId) {
		const autoresponderId = params.triggerId
		return db.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: {
				settingName: `autoresponder-${autoresponderId}`
			}
		})
		.then(result => {
			const stepname = params.triggerStep || 'Start'
			const startStep = result && result.Item && result.Item.value
			&& result.Item.value.steps && result.Item.value.steps[stepname]
			if (!startStep) {
				console.log('Start step not found')
				return
			}
			
			const runAt = Date.now()
			const runAtModified = `${runAt}${Math.random().toString().substring(1)}`
			const queueItem = Object.assign({}, startStep, {
				queuePlacement: 'queued',
				runAtModified,
				runAt,
				attempts: 0,
				failed: false,
				completed: false,
				subscriber,
				subscriberId: subscriber.subscriberId,
				autoresponderId,
				autoresponderStep: stepname,
			})
			return db.put({
				TableName: `${dbTablePrefix}Queue`,
				Item: queueItem,
			})
		})
	}
	return Promise.resolve()
}

exports.handler = (event, context, callback) => {
	const input = getSubscriberData(event.body) // Subscriber data
	if (!input) {
		return callback(null, response(400, 'Bad request'))
	}
	triggerSchema.validate(input)
	.then(subscriberBasic => getFullSubscriber(subscriberBasic))
	.then(fullSubscriber => {
		if (!fullSubscriber) {
			return callback(null, response(404, 'Subscriber not found'))
		}
		return runTrigger(event.queryStringParameters, fullSubscriber)
		.then(() => callback(null, response(200, 'OK')))
	})
	.catch(err => {
		console.log(`Error triggering autoresponder: ${err.message}`)
		return callback(null, response(500))
	})
}
