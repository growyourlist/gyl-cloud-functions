const dynamodb = require('dynopromise-client')
const Joi = require('@hapi/joi')

const db = dynamodb()

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const subscriberDoesNotExistMessage = 'Subscriber does not exist.'

const addTagSchema = Joi.object().keys({
	email: Joi.string().lowercase().email().required(),
	tag: Joi.string().regex(/^[\w-]+$/).min(1).max(26).required(),
})

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberByEmail = email => db.query({
	TableName: `${dbTablePrefix}Subscribers`,
	IndexName: 'EmailToStatusIndex',
	KeyConditionExpression: 'email = :email',
	ExpressionAttributeValues: {
		':email': email
	},
})
.then(results => {
	if (!results.Count) {
		throw new Error(subscriberDoesNotExistMessage)
	}
	return results.Items[0]
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
const getAddTagRequest = rawInput => {
	try {
		return JSON.parse(rawInput)
	}
	catch (ex) {
		return null
	}
}

const addTag = (email, tag) => getSubscriberByEmail(email)
.then(subscriber => {
	const currentIndex = subscriber.tags.indexOf(tag)

	// If the tag already exists, there's no more work to do.
	if (currentIndex >= 0) {
		return
	}
	const newTags = subscriber.tags.slice()
	newTags.push(tag)
	return Promise.all([
		db.update({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriber.subscriberId },
			UpdateExpression: "set #tags = :tags",
			ExpressionAttributeNames: { '#tags': 'tags' },
			ExpressionAttributeValues: { ':tags': newTags },
		}),
	])
})

exports.handler = (event, context, callback) => {
	const addTagRequest = getAddTagRequest(event.body)
	if (!addTagRequest) {
		return callback(null, response(400, 'Invalid request'))
	}
	addTagSchema.validate(addTagRequest)
	.then(input => addTag(input.email, input.tag))
	.then(() => callback(null, response(200, 'OK')))
	.catch(err => {
		if (err.message === subscriberDoesNotExistMessage) {
			return callback(null, response(404, 'Not found'))
		}
		console.log(`Error untagging: ${err.message}`)
		return callback(null, response(500, 'Server error'))
	})
}
