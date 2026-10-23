from configparser import ConfigParser
from client import bot


config = ConfigParser()
config.read("config.ini")

bot_c = config['bot']
bot = bot.Bot(prefix=bot_c.get('prefix', '!'))

if __name__ == "__main__":
    bot.run(token=bot_c['token'], root_logger=True)
