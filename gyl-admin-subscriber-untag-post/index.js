const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

// Schema to validate the request to add a tag.
const addTagSchema = Joi.object({
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
	const currentIndex = newTags.indexOf(tag);
	if (currentIndex < 0) {
		// Tag does not exist, can return
		return;
	}

	newTags.splice(currentIndex, 1);
	return dynamodb
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
		const addTagRequest = JSON.parse(event.body);
		const addTagData = await addTagSchema.validateAsync(addTagRequest);
		await removeTag(addTagData.email, addTagData.tag);
		return response(200, JSON.stringify('OK'));
	} catch (err) {
		console.error(err);
		return response(err.statusCode || 500, err.message || 'Error');
	}
};
