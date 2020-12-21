const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const { queryAllForDynamoDB, ReturnType } = require('query-all-for-dynamodb');
const { writeAllForDynamoDB } = require('write-all-for-dynamodb');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const unsubscribeSchema = Joi.object({
	allEmails: Joi.boolean().required(),
	email: Joi.string().lowercase().email().required(),
	unsubscribeTokenValue: Joi.string().length(12).hex().lowercase().required(),
	listIds: Joi.array().items(Joi.string().max(64)).max(64).required(),
});

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberStatusByEmail = async (email) => {
	const subscriberStatusResponse = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': email,
			},
		})
		.promise();
	if (!subscriberStatusResponse.Count || !subscriberStatusResponse.Items[0]) {
		return null;
	}
	return subscriberStatusResponse.Items[0];
};

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @param  {String} url URL to redirect to.
 * @return {Object}
 */
const response = (statusCode, body) => {
	return {
		statusCode,
		headers: { 'Access-Control-Allow-Origin': '*' },
		body: JSON.stringify(body),
	};
};

/**
 * Deletes a list of queue items from the queue.
 * @param {Object[]} queueItems
 */
const deleteQueueItems = async (queueItems) => {
	if (!queueItems || !queueItems.length) {
		return;
	}
	await writeAllForDynamoDB(dynamodb, {
		RequestItems: {
			[`${dbTablePrefix}Queue`]: queueItems.map((queueItem) => ({
				DeleteRequest: {
					Key: {
						queuePlacement: queueItem.queuePlacement,
						runAtModified: queueItem.runAtModified,
					},
				},
			})),
		},
	});
};

/**
 * Sets a subscribe to unsubscribed and removes all their items from the queue.
 * @param {String} subscriberId
 */
const unsubscribeSubscriberFromAll = async (subscriberId) => {
	await dynamodb
		.update({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriberId },
			UpdateExpression: 'set #unsubscribed = :true',
			ExpressionAttributeNames: { '#unsubscribed': 'unsubscribed' },
			ExpressionAttributeValues: { ':true': true },
		})
		.promise();
	const queueResponse = await queryAllForDynamoDB(
		dynamodb,
		{
			TableName: `${dbTablePrefix}Queue`,
			IndexName: 'SubscriberIdIndex',
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
		},
		{ returnType: ReturnType.items }
	);
	await deleteQueueItems(queueResponse.Items);
};

/**
 * Removes the list tags from a subscribe and all associated queue items.
 * @param {Object} subscriberStatus
 * @param {String[]} listIds
 */
const unsubscribeSubscriberFromLists = async (subscriberStatus, listIds) => {
	const { subscriberId, tags } = subscriberStatus;
	let newTags = tags.slice();
	listIds.forEach((listId) => {
		const tagIndex = newTags.indexOf(listId);
		if (tagIndex >= 0) {
			newTags.splice(tagIndex, 1);
		}
	});
	const subscriberUpdateParams = {
		TableName: `${dbTablePrefix}Subscribers`,
		Key: { subscriberId },
		UpdateExpression: 'set #tags = :tags',
		ExpressionAttributeNames: { '#tags': 'tags' },
		ExpressionAttributeValues: { ':tags': newTags },
	};
	if (!newTags.length) {
		subscriberUpdateParams.UpdateExpression +=
			', #unsubscribed = :unsubscribed';
		subscriberUpdateParams.ExpressionAttributeNames['#unsubscribed'] =
			'unsubscribed';
		subscriberUpdateParams.ExpressionAttributeValues[':unsubscribed'] = true;
	}
	await dynamodb.update(subscriberUpdateParams).promise();
	const queryParams = {
		TableName: `${dbTablePrefix}Queue`,
		IndexName: 'SubscriberIdIndex',
		KeyConditionExpression: '#subscriberId = :subscriberId',
		FilterExpression: '#queuePlacement = :queued and (',
		ExpressionAttributeNames: {
			'#subscriberId': 'subscriberId',
			'#queuePlacement': 'queuePlacement',
			'#tagReason': 'tagReason',
		},
		ExpressionAttributeValues: {
			':subscriberId': subscriberId,
			':queued': 'queued',
		},
	};
	queryParams['FilterExpression'] += listIds
		.map((listId, index) => {
			return `contains(#tagReason, :listId${index})`;
		})
		.join(' or ');
	queryParams['FilterExpression'] += ')';
	listIds.forEach((listId, index) => {
		queryParams['ExpressionAttributeValues'][`:listId${index}`] = listId;
	});
	const queueResponse = await queryAllForDynamoDB(dynamodb, queryParams, {
		returnType: ReturnType.items,
	});
	await deleteQueueItems(queueResponse.Items);
};

exports.handler = async (event) => {
	try {
		let unsubscribeData = null;
		try {
			unsubscribeData = await unsubscribeSchema.validateAsync(
				JSON.parse(event.body)
			);
		} catch (err) {
			return response(400, 'Bad request');
		}

		const status = await getSubscriberStatusByEmail(unsubscribeData.email);
		if (!status) {
			return response(404, 'Not found');
		}
		if (
			!status.unsubscribeToken ||
			!status.unsubscribeToken.created ||
			!status.unsubscribeToken.value ||
			status.unsubscribeToken.created < Date.now() - 172800000
		) {
			// No token, or token is older than 48 hours
			return response(403, 'Forbidden: expired token');
		}
		if (
			status.unsubscribeToken.value !== unsubscribeData.unsubscribeTokenValue
		) {
			// Token sent by user does not match token in database
			return response(403, 'Forbidden: invalid token');
		}

		if (unsubscribeData.allEmails) {
			await unsubscribeSubscriberFromAll(status.subscriberId);
		} else if (unsubscribeData.listIds.length) {
			await unsubscribeSubscriberFromLists(status, unsubscribeData.listIds);
		}
		// Note: above conditions mean that if not unsubscribing from allEmails and
		// there are no listIds to unsubscribe from, no action will be taken.
		return response(200, 'OK');
	} catch (err) {
		console.error(err);
		return response(500, 'Server error');
	}
};
