const dynamodb = require('dynopromise-client')
const isemail = require('isemail')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

let dbConfig = null
if (process.env.TEST_AWS_REGION && process.env.TEST_AWS_DB_ENDPOINT) {
	dbConfig = {
		region: process.env.TEST_AWS_REGION,
		endpoint: process.env.TEST_AWS_DB_ENDPOINT,
	}
}
const db = dbConfig ? dynamodb(dbConfig) : dynamodb()

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
		body: typeof body === 'string' ? body : JSON.stringify(body),
	}
}

exports.handler = (event, context, callback) => {
	const subscriberEmail = event.queryStringParameters['email']
	if (!subscriberEmail || !isemail.validate(subscriberEmail)) {
		return callback(null, response(400, 'Bad request'))
	}
	getSubscriberIdByEmail(subscriberEmail)
	.then(subscriberStatus => {
		if (!subscriberStatus) {
			return callback(null, response(404, 'Not found'))
		}
		callback(null, response(200, subscriberStatus))
	})
	.catch(err => {
		console.log(`Error getting status: ${err.message}`)
		callback(null, response(500, 'Server error'))
	})
}
