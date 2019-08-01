const db = require('dynopromise-client')()

const dbTablePrefix = process.env.DB_TABLE_PREFIX || '';

exports.handler = async (event) => {
	const dbResult = await db.get({
		TableName: `${dbTablePrefix}Settings`,
		Key: { settingName: 'lists' },
	})
  const response = {
		headers: {
			'Access-Control-Allow-Origin': '*'
		},
	  statusCode: 200,
    body: JSON.stringify(dbResult.Item.value),
  }
  return response
}
