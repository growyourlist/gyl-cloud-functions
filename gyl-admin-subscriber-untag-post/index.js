const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const { queryAllForDynamoDB } = require('query-all-for-dynamodb');
const { writeAllForDynamoDB } = require('write-all-for-dynamodb');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Schema to validate the request to add a tag.
const unTagSchema = Joi.object({
	email: Joi.string().lowercase().email().required(),
	tag: Joi.string()
		.regex(/^[\w-]+$/)
		.min(1)
		.max(64)
		.required(),
});

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
			'Content-Type': 'text/plain; charset=utf-8',
		},
		body: body,
	};
};

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberByEmail = async (email) => {
	const subscriberResponse = await dynamodb
		.query({
			TableName: `${dbTablePrefix}Subscribers`,
			IndexName: 'EmailToStatusIndex',
			KeyConditionExpression: 'email = :email',
			ExpressionAttributeValues: {
				':email': email,
			},
		})
		.promise();
	if (!subscriberResponse.Count) {
		throw new Error('Subscriber not found');
	}
	const subscriber = subscriberResponse.Items[0];
	if (!subscriber) {
		throw new Error('Subscriber not found');
	}
	return subscriber;
};

/**
 * Removes a tag from the subscriber with the given email address.
 */
const removeTag = async (email, tag) => {
	const subscriber = await getSubscriberByEmail(email);
	const newTags = (subscriber.tags || []).slice();

	const queueResponse = await queryAllForDynamoDB(dynamodb, {
		TableName: `${dbTablePrefix}Queue`,
		IndexName: 'SubscriberIdIndex',
		KeyConditionExpression: '#subscriberId = :subscriberId',
		FilterExpression:
			'#queuePlacement = :queued and (contains(#tagReason, :tag) or #tagReason = :tag)',
		ExpressionAttributeNames: {
			'#subscriberId': 'subscriberId',
			'#queuePlacement': 'queuePlacement',
			'#tagReason': 'tagReason',
		},
		ExpressionAttributeValues: {
			':subscriberId': subscriber.subscriberId,
			':queued': 'queued',
			':tag': tag,
		},
	});
	if (queueResponse.Items && queueResponse.Items.length) {
		await writeAllForDynamoDB(dynamodb, {
			RequestItems: {
				[`${dbTablePrefix}Queue`]: queueResponse.Items.map((item) => ({
					DeleteRequest: {
						Key: {
							queuePlacement: item.queuePlacement,
							runAtModified: item.runAtModified,
						},
					},
				})),
			},
		});
	}
	const currentIndex = newTags.indexOf(tag);
	if (currentIndex < 0) {
		// Tag does not exist, can return - double check that queue items have been cleared first
		// though
		return;
	}

	newTags.splice(currentIndex, 1);
	await dynamodb
		.update({
			TableName: `${dbTablePrefix}Subscribers`,
			Key: { subscriberId: subscriber.subscriberId },
			UpdateExpression: 'set #tags = :tags',
			ExpressionAttributeNames: { '#tags': 'tags' },
			ExpressionAttributeValues: { ':tags': newTags },
		})
		.promise();
};

exports.handler = async (event) => {
	try {
		const unTagRequest = JSON.parse(event.body);
		const unTagData = await unTagSchema.validateAsync(unTagRequest);
		await removeTag(unTagData.email, unTagData.tag);
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err);
		return response(err.statusCode || 500, err.message || 'Error');
	}
};
