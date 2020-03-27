const AWS = require('aws-sdk');
const Joi = require('@hapi/joi');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const unsubscribeSchema = Joi.object({
	email: Joi.string()
		.lowercase()
		.email()
		.required(),
});

/**
 * Fetches a subscriber id associated with the given email.
 * @param  {String} email
 * @return {Promise<Object>}
 */
const getSubscriberStatusByEmail = async email => {
	const subscriberStatusResponse = await dynamodb.query({
		TableName: `${dbTablePrefix}Subscribers`,
		IndexName: 'EmailToStatusIndex',
		KeyConditionExpression: 'email = :email',
		ExpressionAttributeValues: {
			':email': email,
		},
	}).promise();
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
const redirect = (url) => {
	return {
		statusCode: 303,
		headers: { 
			'Access-Control-Allow-Origin': '*',
			'Location': url,
		},
	};
};

const getUrlParams = (status, unsubscribeToken, listSettings) => {
	const email = status.displayEmail || status.email;
	const lists = [];
	const listsSet = new Set(
		status.tags.filter(a => a.substring(0, 5) === 'list-')
	);
	listSettings.forEach(list => {
		if (listsSet.has(list.id)) {
			lists.push(list)
		}
	});
	const unsubParams = {
		unsubscribed: status.unsubscribed,
		email,
		lists,
		unsubscribeTokenValue: unsubscribeToken.value,
		api: process.env.PUBLIC_API,
	};
	return `p=${encodeURIComponent(JSON.stringify(unsubParams))}`;
}

const getLists = async () => {
	const response = await dynamodb.get({
		TableName: `${dbTablePrefix}Settings`,
		Key: { settingName: 'lists' },
	}).promise();
	return (response.Item && response.Item.value) || [];
}

const addUnsubscribeTokenToUser = async (subscriberId, unsubscribeToken) => {
	await dynamodb.update({
		TableName: `${dbTablePrefix}Subscribers`,
		Key: { subscriberId },
		UpdateExpression: 'SET #unsubscribeToken = :unsubscribeToken',
		KeyConditionExpression: 'attribute_exists(#subscriberId)',
		ExpressionAttributeNames: { '#unsubscribeToken': 'unsubscribeToken' },
		ExpressionAttributeValues: { ':unsubscribeToken': unsubscribeToken },
	}).promise();
}

const generateUnsubscribeToken = () => {
	const length = 12;
	return crypto
		.randomBytes(Math.ceil(length / 2))
		.toString('hex')
		.toLocaleLowerCase();
}

const getCurrentOrNewUnsubscribeToken = async (status) => {
	const { unsubscribeToken, subscriberId } = status
	const twentyFourHourTimeout = Date.now() - 86400000; // now - 24 hrs
	if (!unsubscribeToken || !unsubscribeToken.created || (
		unsubscribeToken.created < twentyFourHourTimeout
	)) {
		// A new unsubscribe token is required, generated it here and save it.
		const newUnsubscribeToken = {
			value: generateUnsubscribeToken(),
			created: Date.now(),
		};
		await addUnsubscribeTokenToUser(subscriberId, newUnsubscribeToken);
		return newUnsubscribeToken;
	}
	// The current unsubscribe token can be used.
	return unsubscribeToken;
}

exports.handler = async event => {
	try {
		let unsubscribeData = null
		try {
			unsubscribeData = await unsubscribeSchema.validateAsync(
				event.queryStringParameters
			);
		}
		catch (err) {
			return redirect(`${process.env.GLOBAL_UNSUBSCRIBE_URL}?error=bad-request`);
		}

		const [ status, lists ] = await Promise.all([
			await getSubscriberStatusByEmail(unsubscribeData.email),
			await getLists(),
		]);
		if (!status) {
			return redirect(`${process.env.GLOBAL_UNSUBSCRIBE_URL}?error=not-found`);
		}
		const unsubscribeToken = await getCurrentOrNewUnsubscribeToken(status);
		const urlParams = getUrlParams(status, unsubscribeToken, lists);
		return redirect(`${process.env.GLOBAL_UNSUBSCRIBE_URL}?${urlParams}`)
	} catch (err) {
		console.error(err);
		return redirect(`${process.env.GLOBAL_UNSUBSCRIBE_URL}?error=server-error`);
	}
}
