const AWS = require('aws-sdk');
const ses = new AWS.SES();

/**
 * Generates a response object with the given statusCode.
 * @param  {Number} statusCode HTTP status code for response.
 * @param  {Any} body Data to be stringified as JSON.
 * @return {Object}
 */
const response = (statusCode, body) => {
	return {
		statusCode: statusCode,
		headers: {
			'Access-Control-Allow-Origin': '*',
		},
		body: JSON.stringify(body),
	};
};

/**
 * Gets the templates stored by SES.
 * @return {Promise}
 */
const getTemplates = async nextToken => {
	const params = {};
	if (nextToken) {
		params.NextToken = nextToken;
	}
	return await ses.listTemplates(params).promise();
};

exports.handler = async event => {
	try {
		const results = await getTemplates(
			event.queryStringParameters && event.queryStringParameters.nextToken
		);
		return response(200, {
			templates: results.TemplatesMetadata || [],
			nextToken: results.NextToken,
		});
	} catch (err) {
		console.error(err);
		return response(500, err.message);
	}
};
