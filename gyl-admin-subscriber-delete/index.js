const dynamodb = require('dynopromise-client')
const batchWriteUntilDone = require('dynopromise-batchwriteuntildone')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
let dbConfig = null
if (process.env.TEST_AWS_DB_ENDPOINT && process.env.TEST_AWS_REGION) {
	dbConfig = {
		region: process.env.TEST_AWS_REGION,
		endpoint: process.env.TEST_AWS_DB_ENDPOINT,
	}
}

const db = dbConfig ? dynamodb(dbConfig) : dynamodb()

const uuidv4Pattern =
/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i

const response = (statusCode, message = '') => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Content-Type': 'text/plain; charset=utf-8'
		},
		body: message
	}
}

exports.handler = (event, context, callback) => {
	const subscriberId = event.queryStringParameters['subscriberId']
	if (uuidv4Pattern.test(subscriberId) !== true) {
		return callback(null, response(400, 'Invalid ID'))
	}
	db.query({
		TableName: `${dbTablePrefix}Queue`,
		IndexName: 'subscriberId-index',
		KeyConditionExpression: '#subscriberId = :subscriberId',
		FilterExpression: '#queuePlacement = :queued',
		ExpressionAttributeNames: {
			'#subscriberId': 'subscriberId',
			'#queuePlacement': 'queuePlacement',
		},
		ExpressionAttributeValues: {
			':subscriberId': subscriberId,
			':queued': 'queued',
		},
	})
	.then(queueResults => {
		if (!(queueResults && queueResults.Items && queueResults.Items.length)) {
			return Promise.resolve()
		}
		const queueItems = queueResults.Items
		const putRequests = []
		queueItems.forEach(item => {
			putRequests.push({
				DeleteRequest: {
					Key: {
						queuePlacement: item.queuePlacement,
						runAtModified: item.runAtModified,
					}
				}
			})
		})

		const batchThreshold = 25
		const batches = []
		let currentBatch = []
		putRequests.forEach(putRequest => {
			if (currentBatch.length === batchThreshold) {
				batches.push(currentBatch)
				currentBatch = []
			}
			currentBatch.push(putRequest)
		})
		batches.push(currentBatch)
		return Promise.all(batches.map(batch => batchWriteUntilDone(
			db,
			{ Queue: batch }
		)))
	})
	.then(() => db.delete({
		TableName: `${dbTablePrefix}Subscribers`,
		Key: {
			subscriberId: subscriberId
		}
	}))
	.then(() => callback(null, response(204)))
	.catch(err => {
		console.log(`Error deleting subscriber: ${err.message}`)
		callback(null, response(500))
	})
}
