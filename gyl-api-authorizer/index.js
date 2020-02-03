const brcypt = require('bcrypt');

const getPolicy = (methodArn, Effect) => {
	return {
		principalId: 'gyl-admin',
		policyDocument: {
			Version: '2012-10-17',
			Statement: [
				{
					Action: 'execute-api:Invoke',
					Effect,
					Resource: `${methodArn
						.split('/')
						.slice(0, 1)
						.join()}/*`,
				},
			],
		},
	}
}

exports.authorizer = async event => {
	const headers = event.headers;
	const authKey = headers['x-gyl-auth-key'] || headers['X-Gyl-Auth-Key']
	if ((typeof authKey !== 'string') || (!authKey.trim())) {
		return getPolicy(event.methodArn, 'Deny')
	}
	const match = await brcypt.compare(
		authKey,
		process.env.ApiAuthKeyHash
	);
	if (match) {
		return getPolicy(event.methodArn, 'Allow');
	} else {
		return getPolicy(event.methodArn, 'Deny')
	}
};
