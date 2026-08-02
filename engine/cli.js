import readline from 'readline';

export function startCLI({ botManager, store }) {
    if (!process.stdin.isTTY) return;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'signalbot> ',
    });

    const printList = () => {
        const bots = botManager.listBots();
        if (!bots.length) {
            console.log('No bots.');
            return;
        }
        for (const bot of bots) {
            const status = bot.isActive ? 'RUNNING' : 'STOPPED';
            console.log(
                `[${bot.id}] ${bot.config.symbol} | ${bot.config.strategy} | ${status} | W/L ${bot.wins}/${bot.losses} | ${bot.pnl >= 0 ? '+' : ''}${bot.pnl.toFixed(2)}`,
            );
        }
    };

    console.log('CLI ready. Commands: list, create <strategy> <symbol> <tf> [lot], start <id>, stop <id>, remove <id>, help, exit');
    rl.prompt();

    rl.on('line', (line) => {
        const [command, ...args] = line.trim().split(/\s+/);
        if (!command) {
            rl.prompt();
            return;
        }

        try {
            if (command === 'list') {
                printList();
            } else if (command === 'create') {
                const [strategy = 'breakout_trend', symbol = 'R_100', tf = '300', lotSize = '0.01'] = args;
                const bot = botManager.createBot({ strategy, symbol, tf: Number(tf), lotSize: Number(lotSize) });
                console.log(`Created bot #${bot.id}`);
            } else if (command === 'start') {
                botManager.startBot(args[0]);
                console.log(`Bot #${args[0]} started.`);
            } else if (command === 'stop') {
                botManager.stopBot(args[0]);
                console.log(`Bot #${args[0]} stopped.`);
            } else if (command === 'remove') {
                botManager.removeBot(args[0]);
                console.log(`Bot #${args[0]} removed.`);
            } else if (command === 'help') {
                console.log('Commands: list, create <strategy> <symbol> <tf> [lot], start <id>, stop <id>, remove <id>, exit');
            } else if (command === 'exit' || command === 'quit') {
                rl.close();
                return;
            } else {
                console.log(`Unknown command: ${command}`);
            }
        } catch (error) {
            store.pushLog(`CLI command failed (${command}): ${error.message}`, 'warn');
            console.log(`Error: ${error.message}`);
        }

        rl.prompt();
    });
}

