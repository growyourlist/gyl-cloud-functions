const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

exports.handler = async (event) => {
	try {
		let tags = null,
			properties = null,
			interactions = null,
			excludeTags = null,
			ignoreConfirmed = null,
			interactionWithAnyEmail = null;
		try {
			const input = JSON.parse(event.body);
			ignoreConfirmed = input.ignoreConfirmed;
			interactionWithAnyEmail = input.interactionWithAnyEmail;
			if (Array.isArray(input.tags)) {
				input.tags.forEach((item) => {
					if (typeof item !== 'string') {
						throw new Error('Invalid tags');
					}
				});
				tags = input.tags;
			} else {
				tags = [];
			}
			if (Array.isArray(input.excludeTags)) {
				input.excludeTags.forEach((item) => {
					if (typeof item !== 'string') {
						throw new Error('Invalid exclude tags');
					}
				});
				excludeTags = input.excludeTags;
			} else {
				excludeTags = [];
			}
			if (typeof input.properties === 'object') {
				Object.keys(input.properties).forEach((prop) => {
					if (typeof input.properties[prop] !== 'string') {
						throw new Error('Invalid properties');
					}
				});
				properties = input.properties;
			} else {
				properties = null;
			}
			if (Array.isArray(input.interactions)) {
				interactions = input.interactions;
			} else {
				interactions = null;
			}
		} catch (err) {
			return {
				statusCode: 400,
				headers: { 'Access-Control-Allow-Origin': '*' },
				body: 'Bad request',
			};
		}
		await dynamodb
			.put({
				TableName: `${dbTablePrefix}Settings`,
				Item: {
					settingName: 'previewSubscriberCount',
					value: {
						status: 'triggered',
						count: 0,
						tags,
						excludeTags,
						properties,
						interactions,
						interactionWithAnyEmail,
						ignoreConfirmed,
					},
				},
			})
			.promise();
		return {
			statusCode: 200,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify('OK'),
		};
	} catch (err) {
		console.error(err);
		return {
			statusCode: 500,
			headers: { 'Access-Control-Allow-Origin': '*' },
			body: JSON.stringify(err.message),
		};
	}
};
