const dynamodb = require('dynopromise-client')
const db = dynamodb()

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const readMessageData = event => new Promise((resolve, reject) => {
	try {
		return resolve(JSON.parse(event.Records[0].Sns.Message.trim()))
	}
	catch (err) {
		return reject(err)
	}
})

const getSubscriberByEmail = email => db.query({
	TableName: `${dbTablePrefix}Subscribers`,
	IndexName: 'EmailToStatusIndex',
	KeyConditionExpression: '#email = :email',
	ExpressionAttributeNames: {
		'#email': 'email',
	},
	ExpressionAttributeValues: {
		':email': email,
	}
})
.then(results => {
	if (!results.Count) {
		throw new Error('Subscriber does not exist.')
	}
	return results.Items[0]
})

exports.handler = (event, context, callback) => {
	readMessageData(event)
	.then(message => {
		const eventType = message.eventType
		if (eventType === 'Complaint' || (eventType === 'Bounce' && message.bounce.bounceType === 'Permanent')) {
			const detailName = eventType.toLowerCase()
			const details = message[detailName]
			let email = null
			if (eventType === 'Complaint') {
				email = details.complainedRecipients[0].emailAddress.toLowerCase()
			}
			else if (eventType === 'Bounce') {
				email = details.bouncedRecipients[0].emailAddress.toLowerCase()
			}
			if (!email) {
				throw new Error('Email not found in event')
			}
			return getSubscriberByEmail(email)
			.then(subscriber => {
				if (subscriber.unsubscribed) {
					return
				}
				let reason = 'Other'
				if (eventType === 'Complaint') {
					reason = 'Complaint'
				}
				else if (eventType === 'Bounce' && message.bounce.bounceType === 'Permanent') {
					reason = 'Bounce - Permanent'
				}
				Promise.all([
					db.update({
						TableName: `${dbTablePrefix}Subscribers`,
						Key: { subscriberId: subscriber.subscriberId },
						UpdateExpression: 'set #unsubscribed = :true, #timestamp = :now, #unsubscribeReason = :reason',
						ExpressionAttributeNames: {
							'#unsubscribed': 'unsubscribed',
							'#timestamp': 'unsubscribeTimestamp',
							'#unsubscribeReason': 'unsubscribeReason',
						},
						ExpressionAttributeValues: {
							':true': true,
							':now': Date.now(),
							':reason': reason,
						}
					}),
					db.query({
						TableName: `${dbTablePrefix}Queue`,
						IndexName: 'subscriberId-index',
						KeyConditionExpression: '#subscriberId = :subscriberId',
						FilterExpression: '#queuePlacement = :queued',
						ExpressionAttributeNames: {
							'#subscriberId': 'subscriberId',
							'#queuePlacement': 'queuePlacement'
						},
						ExpressionAttributeValues: {
							':subscriberId': subscriber.subscriberId,
							':queued': 'queued'
						},
					})
					.then(queueResults => {
						if (!(queueResults.Items && queueResults.Items.length)) {
							return
						}
						const queueItems = queueResults.Items
						const requests = []
						queueItems.forEach(item => {
							requests.push({
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
						requests.forEach(request => {
							if (currentBatch.length === batchThreshold) {
								batches.push(currentBatch)
								currentBatch = []
							}
							currentBatch.push(request)
						})
						batches.push(currentBatch)
						return Promise.all(batches.map(batch => db.batchWrite({
							RequestItems: {
								Queue: batch
							}
						})))
					})
				])
			})
		}
	})
	.catch(err => console.log(`Error handling event: ${err.message}`))
};
