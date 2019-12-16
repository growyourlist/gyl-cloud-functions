const AWS = require('aws-sdk')
const { fullQueryForDynamoDB } = require('full-query-for-dynamodb')
const dynamodb = require('dynopromise-client')

const dbConfig = {
	region: process.env.AWS_REGION,
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
}

const isLambda = !!process.env.AWS_EXECUTION_ENV

const promiseDb = isLambda ? dynamodb() : dynamodb(dbConfig)
const awsDb = isLambda ? (new AWS.DynamoDB.DocumentClient()) : (
	new AWS.DynamoDB.DocumentClient(dbConfig)
)

exports.handler = async (event) => {
	try {

		// Light validation (just needs to be good enough for a non-sql query)
		if (
			!event.queryStringParameters ||
			(typeof event.queryStringParameters.email !== 'string') ||
			(event.queryStringParameters.email.length > 256) ||
			(event.queryStringParameters.email.length < 1)
		) {
			return {
				statusCode: 400,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: 'Bad request',
			}
		}

		// Get the subscriber, if they exist.
		const { email } = event.queryStringParameters
		const subscriberStatusResponse = await promiseDb.query({
			TableName: 'Subscribers',
			KeyConditionExpression: '#email = :email',
			IndexName: 'EmailToStatusIndex',
			ExpressionAttributeNames: {
				'#email': 'email',
			},
			ExpressionAttributeValues: {
				':email': email
			}
		})

		// Exit if there's no subscriber at this point.
		if (
			!subscriberStatusResponse ||
			!Array.isArray(subscriberStatusResponse.Items) ||
			!subscriberStatusResponse.Items[0] ||
			!subscriberStatusResponse.Items[0].subscriberId
		) {
			return {
				statusCode: 404,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: 'Not Found',
			}
		}

		// Fetch the history for the subscriber.
		const { subscriberId } = subscriberStatusResponse.Items[0]
		const history = await fullQueryForDynamoDB(awsDb, {
			TableName: 'Queue',
			IndexName: 'subscriberIdAndTagReason-index',
			KeyConditionExpression: '#subscriberId = :subscriberId',
			ExpressionAttributeNames: {
				'#subscriberId': 'subscriberId',
			},
			ExpressionAttributeValues: {
				':subscriberId': subscriberId,
			},
		})

		history.sort((a, b) => b.runAt - a.runAt)
		const itemDetails = await promiseDb.batchGet({
			RequestItems: {
				'Queue': {
					Keys: history.slice(0, 100).map(item => {
						const { queuePlacement, runAtModified } = item
						return { queuePlacement, runAtModified }
					})
				}
			}
		})

		const fullItems = (itemDetails.Responses.Queue || []).concat(history.slice(100))

		// Return the result
		return {
			statusCode: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(fullItems),
		}

	}
	catch (err) {

		// Log any errors encountered and return server error if we don't know what
		// went wrong.
		console.error(err)
		return {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: 'Server error',
		}
	}
}
