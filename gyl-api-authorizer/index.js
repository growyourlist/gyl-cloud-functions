const brcypt = require('bcrypt');

exports.authorizer = async event => {
	const headers = event.headers;
	const match = await brcypt.compare(
		headers['X-Gyl-Auth-Key'],
		process.env.ApiAuthKeyHash
	);
	if (match) {
		return {
			principalId: 'gyl-admin',
			policyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Action: 'execute-api:Invoke',
						Effect: 'Allow',
						Resource: `${event.methodArn
							.split('/')
							.slice(0, 1)
							.join()}/*`,
					},
				],
			},
		};
	} else {
		return {
			principalId: 'gyl-admin',
			policyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Action: 'execute-api:Invoke',
						Effect: 'Deny',
						Resource: `${event.methodArn
							.split('/')
							.slice(0, 1)
							.join()}/*`,
					},
				],
			},
		};
	}
};
