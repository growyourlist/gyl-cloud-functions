const { readdirSync, existsSync } = require('fs');
const { sep, join, resolve, basename } = require('path');
const { sync: spawnSync } = require('cross-spawn');

const errorPattern = /(\berr\b|\berror\b)/i;

const runNpmOutdated = async (dir) => {
	const proc = spawnSync('npm', ['outdated'], {
		cwd: dir,
		encoding: 'utf8',
	});
	if (proc.stdout) {
		console.log(basename(dir));
		process.stdout.write(proc.stdout);
	}
	if (proc.stderr) {
		process.stderr.write(proc.stderr);
	}
};

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
		const targetFolderInput = process.argv[2] && resolve(process.argv[2]);
		let targetFolders = targetFolderInput
			? dirs.filter((dir) => {
					return resolve(dir) === targetFolderInput;
			  })
			: dirs;
		let dirName = targetFolders.pop();
		while (dirName) {
			const dir = join(process.cwd(), dirName);
			await runNpmOutdated(dir);
			dirName = targetFolders.pop();
		}
	} catch (err) {
		console.error(err);
	}
};

run();
