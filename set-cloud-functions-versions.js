const { readdirSync, existsSync, readFileSync, writeFileSync } = require('fs');
const { sep, join, resolve } = require('path');

const run = async () => {
	try {
		const dirs = readdirSync(__dirname, { withFileTypes: true })
			.filter(
				// Get all the directories containing package.json files, as these
				// should be the directories containing cloud function node packages.
				(i) =>
					i.isDirectory() &&
					existsSync(`${__dirname}${sep}${i.name}${sep}package.json`)
			)
			.map((i) => i.name);
		const version = process.argv[2];
		if (!version || !/\d+\.\d+\.\d+/.test(version)) {
			throw new Error('Please enter a version as the first argument');
		}
		const targetFolderInput = process.argv[3] && resolve(process.argv[3]);
		let targetFolders = targetFolderInput
			? dirs.filter((dir) => {
					return resolve(dir) === targetFolderInput;
				})
			: dirs;
		let dirName = targetFolders.pop();
		while (dirName) {
			console.log(`Setting version ${version} for ${dirName}`);
			const dir = join(process.cwd(), dirName);
			const packageFileName = join(dir, 'package.json');
			const packageData = JSON.parse(
				readFileSync(packageFileName, { encoding: 'utf8' })
			);
			packageData.version = version;
			const packageDataString = JSON.stringify(packageData, null, 2) + '\n';
			writeFileSync(packageFileName, packageDataString, { encoding: 'utf8' });
			dirName = targetFolders.pop();
		}
	} catch (err) {
		console.error(err);
	}
};

run();
