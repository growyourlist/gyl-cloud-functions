const { DynamoDB } = require('aws-sdk')
const { fullQueryForDynamoDB, ReturnType } = require('full-query-for-dynamodb')

const dynamodb = new DynamoDB.DocumentClient()

const getSubscriber = email => new Promise((resolve, reject) => {
	dynamodb.query({
		TableName: 'Subscribers',
		IndexName: 'EmailToStatusIndex',
		KeyConditionExpression: '#email = :email',
		ExpressionAttributeNames: { '#email': 'email' },
		ExpressionAttributeValues: { ':email': email },
	}, (err, data) => {
		if (err) {
			reject(err)
			return
		}
		if (!data.Count) {
			resolve(null)
			return
		}
		resolve(data.Items[0])
	})
})

const getQueueItems = async (subscriberId) => {
	return await fullQueryForDynamoDB(
		dynamodb,
		{
			TableName: 'Queue',
			IndexName: 'subscriberIdAndTagReason',
			KeyConditionExpression: '#subscriberId = :subscriberId',
			FilterExpression: '#queuePlacement = :queuePlacement',
			ExpressionAttributeNames: {
				'#subscriberId': 'subscriberId',
				'#queuePlacement': 'queuePlacement',
			},
			ExpressionAttributeValues: {
				':subscriberId': subscriberId,
				':queuePlacement': 'queued',
			},
		},
		{
			returnType: ReturnType.items
		}
	)
}

const run = async (input) => {
	try {
		if (!input || !input.email) {
			throw new Error('No email provided')
		}
		const { email } = input
		if (email.length > 256) {
			throw new Error('Email too large')
		}
		const subscriber = await getSubscriber(input.email)
		if (!subscriber) {
			throw new Error('Subscriber not found')
		}
		await getQueueItems(subscriber.subscriberId)
	}
	catch (err) {
		console.error(err)
	}
}

run()
