exports.authorizer = async (event) => {
	console.log(JSON.stringify(event))
	const headers = event.headers
	if (headers.Test === process.env.ApiAuthKeyHash) {
		return {
			principalId: 'me',
			policyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Action: 'execute-api:Invoke',
						Effect: 'Allow',
						Resource: event.methodArn
					}
				]
			}
		}
	}
	else {
		return '401 Unauthorized'
	}
}
