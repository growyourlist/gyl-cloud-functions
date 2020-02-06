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

const validateName = async name => {
	if (!name) {
		throwValidationError('No name provided');
	}
	if (typeof name !== 'string') {
		throwValidationError('Invalid list name: not a string');
	}
	if (name.length > 64) {
		throwValidationError('Invalid list name: over 64 characters');
	}
};

const validateSourceEmail = async email => {
	if (email === null) {
		return; // null is a valid value
	}
	if (typeof email !== 'string') {
		throwValidationError('Invalid source email: not a string');
	}
	const emailPatternWithLabel = /^.*<[^\s@]+@[^\s@]+\.[^\s@]+>$/;
	const matchesLabelPattern = emailPatternWithLabel.test(email);
	if (matchesLabelPattern) {
		if (email.length > 256) {
			throwValidationError('Invalid source email: labelled email too long');
		}

		// Email with label and valid length, can return at this point
		return;
	}
	const emailPatternBasic = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const matchesBasicPattern = emailPatternBasic.test(email);
	if (matchesBasicPattern) {
		if (email.length > 254) {
			throwValidationError('Invalid source email: email address too long');
		}
	} else {
		throwValidationError('Invalid source email: does not appear to be email');
	}
};

exports.handler = async event => {
	try {
		const listData = JSON.parse(event.body);
		if (Object.keys(listData).length !== 3) {
			throwValidationError('Bad Request');
		}
		await validateId(listData.id);
		await validateName(listData.name);
		await validateSourceEmail(listData.sourceEmail);
		const currentRes = await dynamodb
			.get({
				TableName: `${dbTablePrefix}Settings`,
				Key: { settingName: 'lists' },
			})
			.promise();
		const settingExists = !!currentRes.Item;
		const settingValueExists =
			settingExists && Array.isArray(currentRes.Item.value);
		const listSetting = settingValueExists
			? currentRes.Item
			: {
					settingName: 'lists',
					value: [],
				};
		const currentIndex = listSetting.value.findIndex(i => i.id === listData.id);
		const newList =
			currentIndex >= 0
				? Object.assign({}, listSetting.value[currentIndex], {
						name: listData.name,
						sourceEmail: listData.sourceEmail || null,
					})
				: {
						name: listData.name,
						id: listData.id,
						sourceEmail: listData.sourceEmail || null,
					};
		if (currentIndex >= 0) {
			listSetting.value.splice(currentIndex, 1, newList);
		} else {
			listSetting.value.push(newList);
		}
		const verb = currentIndex >= 0 ? 'updated' : 'created';

		const updateQuery = {
			TableName: `${dbTablePrefix}Settings`,
			Key: { settingName: 'lists' },
			UpdateExpression: 'set #value = :newValue',
			ExpressionAttributeNames: {
				'#value': 'value',
			},
			ExpressionAttributeValues: {
				':newValue': listSetting.value,
			},
		};

		await dynamodb.update(updateQuery).promise();

		return {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(`List ${verb}`),
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
