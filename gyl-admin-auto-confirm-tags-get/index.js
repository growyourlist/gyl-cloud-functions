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
		const res = await lambda
			.getFunctionConfiguration({
				FunctionName: 'GylReactToInteraction',
			})
			.promise();
		const autoConfirmTags =
			(res.Environment &&
				res.Environment.Variables &&
				res.Environment.Variables.AUTO_CONFIRM_TAGS) ||
			'';
		return response(200, { autoConfirmTags });
	} catch (err) {
		console.error(err);
		return response(500, err.message);
	}
};
