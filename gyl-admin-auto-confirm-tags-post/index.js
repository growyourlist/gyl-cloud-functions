const AWS = require('aws-sdk');

const lambda = new AWS.Lambda();

const response = (statusCode, body) => {
	return {
		statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
		},
		body: JSON.stringify(body),
	};
};

exports.handler = async (event) => {
	try {
		const input = JSON.parse(event.body);
		if (
			typeof input !== 'object' ||
			typeof input.autoConfirmTags !== 'string'
		) {
			return response(400, 'Bad request');
		}
		const res = await lambda
			.getFunctionConfiguration({
				FunctionName: 'GylReactToInteraction',
			})
			.promise();
		const Variables = (res.Environment && res.Environment.Variables) || {};
		Variables.AUTO_CONFIRM_TAGS = input.autoConfirmTags;
		await lambda
			.updateFunctionConfiguration({
				FunctionName: 'GylReactToInteraction',
				Environment: { Variables },
			})
			.promise();
		return response(200, 'OK');
	} catch (err) {
		console.error(err);
		return response(500, err.message);
	}
};
