const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const getSubscriberByEmail = async email => {
	const results = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: '#email = :email',
			ExpressionAttributeNames: {
				'#email': 'email',
			},
			ExpressionAttributeValues: {
				':email': email,
			},
		})
		.promise();
	if (!results.Count || !results.Items[0]) {
		throw new Error('Subscriber does not exist.');
	}
	return results.Items[0];
};

exports.handler = async event => {
	try {
		const message = JSON.parse(event.Records[0].Sns.Message);
		const eventType = message.eventType;
		if (
			eventType === 'Complaint' ||
			(eventType === 'Bounce' && message.bounce.bounceType === 'Permanent')
		) {
			const detailName = eventType.toLowerCase();
			const details = message[detailName];
			let email = null;
			if (eventType === 'Complaint') {
				email = details.complainedRecipients[0].emailAddress.toLowerCase();
			} else if (eventType === 'Bounce') {
				email = details.bouncedRecipients[0].emailAddress.toLowerCase();
			}
			if (!email) {
				throw new Error('Email not found in event');
			}
			const subscriber = await getSubscriberByEmail(email);
			if (subscriber.unsubscribed) {
				return;
			}
			let reason = 'Other';
			if (eventType === 'Complaint') {
				reason = 'Complaint';
			} else if (
				eventType === 'Bounce' &&
				message.bounce.bounceType === 'Permanent'
			) {
				reason = 'Bounce - Permanent';
			}
			await Promise.all([
				dynamodb
					.update({
						TableName: `${dbTablePrefix}Subscribers`,
						Key: { subscriberId: subscriber.subscriberId },
						UpdateExpression:
							'set #unsubscribed = :true, #timestamp = :now, #unsubscribeReason = :reason',
						ExpressionAttributeNames: {
							'#unsubscribed': 'unsubscribed',
							'#timestamp': 'unsubscribeTimestamp',
							'#unsubscribeReason': 'unsubscribeReason',
						},
						ExpressionAttributeValues: {
							':true': true,
							':now': Date.now(),
							':reason': reason,
						},
					})
					.promise(),
				dynamodb
					.query({
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
					})
					.promise()
					.then(async queueResults => {
						if (!(queueResults.Items && queueResults.Items.length)) {
							return;
						}
						const queueItems = queueResults.Items;
						const requests = [];
						queueItems.forEach(item => {
							requests.push({
								DeleteRequest: {
									Key: {
										queuePlacement: item.queuePlacement,
										runAtModified: item.runAtModified,
									},
								},
							});
						});
						const batchThreshold = 25;
						const batches = [];
						let currentBatch = [];
						requests.forEach(request => {
							if (currentBatch.length === batchThreshold) {
								batches.push(currentBatch);
								currentBatch = [];
							}
							currentBatch.push(request);
						});
						batches.push(currentBatch);
						await Promise.all(
							batches.map(batch =>
								dynamodb
									.batchWrite({
										RequestItems: {
											Queue: batch,
										},
									})
									.promise()
							)
						);
					}),
			]);
		}
	} catch (err) {
		console.error(err);
	}
};
