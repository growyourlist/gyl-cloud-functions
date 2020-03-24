const AWS = require('aws-sdk');
const needle = require('needle');

const ses = new AWS.SES();

/**
 * Summarises the statistics for the account as per day statistics and sends it
 * to a central collection point so the overall health of GrowYourList can be
 * be seen and managed.
 */
exports.handler = async () => {
	try {
		const accountId = process.env.ACCOUNT_ID;
		const centralStatisticsUrl = process.env.CENTRAL_STATISTICS_URL;
		if (!accountId || !centralStatisticsUrl) {
			// Statistics collection is not possible
			return
		}

		const statisticsResponse = await ses.getSendStatistics().promise();

		if (
			!statisticsResponse.SendDataPoints ||
			!statisticsResponse.SendDataPoints.length
		) {
			return null;
		}

		const statistics = {};
		const currentHourId = new Date().toISOString().substring(0, 13);
		statisticsResponse.SendDataPoints.forEach(point => {
			const hourId = point.Timestamp.toISOString().substring(0, 13);
			if (hourId === currentHourId) {
				// Ignore current hour as stats are still being collected generated
				return;
			}
			if (statistics[hourId]) {
				statistics[hourId]['Bounces'] += point.Bounces;
				statistics[hourId]['DeliveryAttempts'] += point.DeliveryAttempts;
				statistics[hourId]['Complaints'] += point.Complaints;
				statistics[hourId]['Rejects'] += point.Rejects;
			} else {
				const { Bounces, DeliveryAttempts, Complaints, Rejects } = point;
				statistics[hourId] = { Bounces, DeliveryAttempts, Complaints, Rejects };
			}
		});

		const statisticsUpdate = {
			gylAccountId: process.env.ACCOUNT_ID,
			statistics,
		};

		await needle(
			'post', process.env.CENTRAL_STATISTICS_URL, statisticsUpdate,
			{ json: true, }
		);
	} catch (err) {
		console.error(err);
	}
};
