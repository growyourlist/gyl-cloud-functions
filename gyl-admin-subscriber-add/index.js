const AWS = require('aws-sdk')
const dynamodb = require('dynopromise-client')
const Joi = require('@hapi/joi')
const uuidv4 = require('uuid/v4')
const moment = require('moment-timezone')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Configure DB and allow for testing with local db.
let dbConfig = null
if (process.env.TEST_AWS_REGION && process.env.TEST_AWS_DB_ENDPOINT) {
	dbConfig = {
		region: process.env.TEST_AWS_REGION,
		endpoint: process.env.TEST_AWS_DB_ENDPOINT,
	}
}
const db = dbConfig ? dynamodb(dbConfig) : dynamodb()

// Configure SES and allow for testing with mock.
const ses = process.env.TEST_AWS_FAKE_SES ? {
	sendTemplatedEmail: (params, callback) => {
		const email = params.Destination.ToAddresses[0]
		const template = params.Template
		console.log(`Fake sending "${template}" template to ${email}`)
		callback(null, null)
	}
} : new AWS.SES()

// Extend Joi to validate the timezone.
const minDate = new Date
minDate.setFullYear(minDate.getFullYear() - 130)
const ExtJoi = Joi.extend(joi => ({
	base: joi.string(),
	name: 'string',
	language: {
		timezone: 'must be a valid timezone'
	},
	rules: [
		{
			name: 'timezone',
			validate(params, value, state, options) {
				if (!moment.tz.zone(value)) {
					return this.createError(
						'string.timezone', value, {}, state, options
					)
				}
				return value
			}
		}
	]
}))

// Schema to validate incoming add subscriber requests from userland.
const addSubscriberSchema = ExtJoi.object().keys({
	email: ExtJoi.string().lowercase().email().required(),
	timezone: ExtJoi.string().timezone(),
	deliveryTimePreference: ExtJoi.object().keys({
		hour: ExtJoi.number().integer().min(0).max(23).required(),
		minute: ExtJoi.number().integer().min(0).max(59).required()
	}),
	tags: ExtJoi.array().allow(null).min(0).max(50).items(
		ExtJoi.string().min(1).max(64)
	),
}).unknown(true)

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberIdByEmail = email => db.query({
	TableName: `${dbTablePrefix}Subscribers`,
	IndexName: 'EmailToStatusIndex',
	KeyConditionExpression: 'email = :email',
	ExpressionAttributeValues: {
		':email': email
	},
})
.then(results => {
	if (!results.Count) {
		return null
	}
	return results.Items[0]
})

const getSubscriberFull = subscriberId => db.get({
	TableName: 'Subscribers',
	Key: { subscriberId },
})
.then(result => {
	if (!result.Item) {
		return null
	}
	return result.Item
})

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

/**
 * Saves subscriber data to the database.
 * @param  {Object} subscriberData
 * @return {Promise}
 */
const saveSubscriber = subscriberData => {
	const fullSubscriber = Object.assign({}, subscriberData, {
		subscriberId: uuidv4(),
		confirmed: false,
		unsubscribed: false,
		joined: Date.now(),
		confirmationToken: uuidv4(),
	})
	return db.put({
		TableName: `${dbTablePrefix}Subscribers`,
		Item: fullSubscriber,
	})
	.then(() => fullSubscriber)
}

/**
 * Sends confirmation email to the subscriber.
 * @param  {String} subscriberId
 * @param  {String} email
 * @return {Promise}
 */
const sendConfirmationEmail = (subscriberData, templateId = null) =>
new Promise((resolve, reject) => {
	const confirmLink = `${process.env.API}subscriber/confirm/?t=`
	const realTemplateId = templateId || 'Confirmation'
	const templateParams = {
		Destination: { ToAddresses: [subscriberData.email] },
		ConfigurationSetName: 'Default',
		Source: process.env.SOURCE_EMAIL,
		Template: realTemplateId,
		TemplateData: JSON.stringify({
			subscriber: subscriberData,
			confirmationLink: `${confirmLink}${subscriberData.subscriberId}`
		}),
		Tags: [{
			Name: 'TemplateId',
			Value: realTemplateId,
		}]
	}
	ses.sendTemplatedEmail(templateParams, (err, data) => {
		if (err) {
			console.log(`Error sending template email: ${err.message}`)
			return reject(err)
		}
		return resolve()
	})
})

const getSubscriberData = body => {
	try {
		return JSON.parse(body)
	}
	catch (ex) {
		return null
	}
}

const hasAllTags = (tagsA, tagsB) => {
	if (!Array.isArray(tagsB) || !tagsB.length) {
		return true // because tagsB has no tags, therefore tagsB needs no tags to
		            // fulfill all the tags of tagsB
	}
	if (!Array.isArray(tagsA) || !tagsA.length) {
		return false // because tagsB is an array with items and this point and
		             // tagsA is not.
	}
	for (let i = 0; i < tagsB.length; i++) {
		if (tagsA.indexOf(tagsB[i]) < 0) {
			return false
		}
	}
	return true
}

const updateSubscriberTags = (existingSub, newTags) => {
	const tagsUpdate = existingSub.tags || []
	const realNewTags = newTags || []
	realNewTags.forEach(tag => {
		if (tagsUpdate.indexOf(tag) < 0) {
			tagsUpdate.push(tag)
		}
	})
	return db.update({
		TableName: `${dbTablePrefix}Subscribers`,
		Key: { subscriberId: existingSub.subscriberId },
		UpdateExpression: 'set #tags = :tags',
		ExpressionAttributeNames: { '#tags': 'tags', },
		ExpressionAttributeValues: { ':tags': tagsUpdate },
	})
	.then(() => tagsUpdate)
}

const runTrigger = (params, subscriber) => {
	if (params && params.triggerType === 'confirmation') {
		return sendConfirmationEmail(subscriber, ((params && params.triggerId) || null))
	}
	else if (params && params.triggerType === 'autoresponder' && params.triggerId) {
		const autoresponderId = params.triggerId
		return db.get({
			TableName: `${dbTablePrefix}Settings`,
			Key: {
				settingName: `autoresponder-${autoresponderId}`
			}
		})
		.then(result => {
			const startStep = result && result.Item && result.Item.value
			&& result.Item.value.steps && result.Item.value.steps.Start
			if (!startStep) {
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
				autoresponderStep: 'Start',
			})
			return db.put({
				TableName: `${dbTablePrefix}Queue`,
				Item: queueItem,
			})
		})
	}
}

exports.handler = (event, context, callback) => {
	const input = getSubscriberData(event.body) // Subscriber data
	if (!input) {
		return callback(null, response(400, 'Bad request'))
	}
	return addSubscriberSchema.validate(input)
	.then(subscriber => {
		const email = subscriber.email
		return getSubscriberIdByEmail(email)
		.then(existingSub => {
			if (!existingSub) {
				return saveSubscriber(subscriber)
				.then(fullSubscriber => {
					const params = event.queryStringParameters
					return runTrigger(params, fullSubscriber)
				})
				.then(() => callback(null, response(200, 'OK')))
			}
			else {
				return getSubscriberFull(existingSub.subscriberId)
				.then(currentSubscriber => {
					if (!hasAllTags(currentSubscriber.tags, subscriber.tags)) {
						return updateSubscriberTags(currentSubscriber, subscriber.tags)
						.then(tags => {
							const fullSubscriber = Object.assign(currentSubscriber, subscriber, {
								tags
							})
							return db.put({
								TableName: 'Subscribers',
								Item: fullSubscriber,
							})
							.then(() => runTrigger(event.queryStringParameters, fullSubscriber))
						})
						.then(() => callback(null, response(200, 'Tag added')))
					}
					else {
						const fullSubscriber = Object.assign(currentSubscriber, subscriber)
						return db.put({
							TableName: 'Subscribers',
							Item: fullSubscriber,
						})
						.then(() => runTrigger(event.queryStringParameters, fullSubscriber))
						.then(() => callback(null, response(200, 'Subscriber updated')))
					}
				})
			}
		})
		.catch(err => {
			console.log(`Error creating subscriber: ${err.message}`)
			return callback(null, response(500))
		})
	})
	.catch(err => {
		console.log(`Subscriber validation error: ${err.message}`)
		return callback(null, response(400))
	})
}
