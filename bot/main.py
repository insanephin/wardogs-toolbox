from client import bot
from utils.config import config


bot = bot.Bot()

if __name__ == "__main__":
    bot.run(token=config.discord_token, root_logger=True)
