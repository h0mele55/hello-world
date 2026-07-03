"""Import every model so `Base.metadata` knows about all tables.

Import this module (or `insbot.models`) before calling create_all / Alembic autogen.
"""
from insbot.models.carrier import Carrier, RateComponent, RateTable
from insbot.models.conversation import ConversationState
from insbot.models.policy import Policy, ReminderLog
from insbot.models.user import Owner, User
from insbot.models.vehicle import Vehicle

__all__ = [
    "User",
    "Owner",
    "Vehicle",
    "Carrier",
    "RateTable",
    "RateComponent",
    "Policy",
    "ReminderLog",
    "ConversationState",
]
