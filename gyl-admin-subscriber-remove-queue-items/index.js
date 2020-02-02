const AWS = require('aws-sdk')
const { queryAllForDynamoDB } = require('query-all-for-dynamodb')
const { writeAllForDynamoDB } = require('write-all-for-dynamodb')

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';
const dynamodb = new AWS.DynamoDB.DocumentClient();

const run = async (input) => {
	try {
		if (!input || (typeof input.email !== 'string')) {
			throw new Error('No email provided')
		}
		const email = input.email.toLocaleLowerCase()
		if (email.length > 256) {
			throw new Error('Email too large')
		}
		const subscriberResponse = await dynamodb.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: '#email = :email',
			ExpressionAttributeNames: { '#email': 'email' },
			ExpressionAttributeValues: { ':email': email },
		}).promise()
		const subscriber = subscriberResponse.Items && subscriberResponse.Items[0]
		if (!subscriber) {
			throw new Error('Subscriber not found')
		}
		const queueInfoResponse = await queryAllForDynamoDB(
			dynamodb,
			{
				TableName: `${dbTablePrefix}Queue`,
				IndexName: 'subscriberId-index',
				KeyConditionExpression: '#subscriberId = :subscriberId',
				FilterExpression: '#queuePlacement = :queued',
				ExpressionAttributeNames: {
					'#subscriberId': 'subscriberId',
					'#queuePlacement': 'queuePlacement',
				},
				ExpressionAttributeValues: {
					':subscriberId': subscriber.subscriberId,
					':queued': 'queued',
				},
			}
		)
		const queueInfoItems = queueInfoResponse.Count && queueInfoResponse.Items;
		if (Array.isArray(queueInfoItems) && queueInfoItems.length) {
			await writeAllForDynamoDB(dynamodb, {
				RequestItems: {
					[`${dbTablePrefix}Queue`]: queueInfoItems.map(item => ({
						DeleteRequest: {
							Key: {
								queuePlacement: item.queuePlacement,
								runAtModified: item.runAtModified,
							}
						}
					}))
				}
			})
		}
	}
	catch (err) {
		console.error(err)
	}
}

run()
