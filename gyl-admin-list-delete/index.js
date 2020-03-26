const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

const throwValidationError = message => {
	const validationError = new Error(message);
	validationError.statusCode = 400;
	throw validationError;
};

const validateId = async id => {
	if (!id) {
		throwValidationError('No list id provided');
	}
	if (typeof id !== 'string') {
		throwValidationError('Invalid list id: not a string');
	}
	if (!/^[a-zA-Z0-9_-]*$/.test(id)) {
		throwValidationError('Invalid list id: contains invalid characters');
	}
	if (id.length > 64) {
		throwValidationError('Invalid list id: over 64 characters');
	}
};

exports.handler = async event => {
	try {
		const listData = JSON.parse(event.body);
		if (Object.keys(listData).length !== 1) {
			throwValidationError('Bad Request');
		}
		await validateId(listData.id);
		const currentRes = await dynamodb
			.get({
				TableName: `${dbTablePrefix}Settings`,
				Key: { settingName: 'lists' },
			})
			.promise();
		const settingExists = !!currentRes.Item;
		const settingValueExists =
			settingExists && Array.isArray(currentRes.Item.value);
		if (!settingValueExists) {
			return {
				statusCode: 404,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: JSON.stringify('Not found')
			}
		}
		const lists = currentRes.Item.value;
		const currentIndex = lists.findIndex(i => i.id === listData.id);
		if (currentIndex < 0) {
			return {
				statusCode: 404,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: JSON.stringify('Not found')
			}
		}

		lists.splice(currentIndex, 1);

		const updateQuery = {
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: 'lists' },
			UpdateExpression: 'set #value = :newValue',
			ExpressionAttributeNames: {
				'#value': 'value',
			},
			ExpressionAttributeValues: {
				':newValue': lists,
			},
		};

		await dynamodb.update(updateQuery).promise();

		return {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(`List deleted`),
		};
	} catch (err) {
		if (err.statusCode !== 400) {
			// Log full errors for all non-validation errors
			console.error(err);
		} else {
			// Log only high-level info about validation errors
			console.log(err.message);
		}
		return {
			headers: { 'Access-Control-Allow-Origin': '*' },
			statusCode: err.statusCode || 500,
			body: JSON.stringify(err.message),
		};
	}
};
