"""Drive the conversation state machine end-to-end against the demo tariffs."""
from __future__ import annotations

from insbot.conversation.service import ConversationService, START, DONE
from insbot.rating.engine import compute_quotes
from insbot.seed import seed_demo


def _run(session, inputs):
    svc = ConversationService(lambda ri: compute_quotes(ri, session))
    state, ctx = START, {}
    reply = None
    for text in inputs:
        turn = svc.handle(state, ctx, text)
        state, ctx, reply = turn.state, turn.context, turn.reply
    return state, reply


def test_full_mtpl_flow_reaches_ranked_quotes(session):
    seed_demo(session)
    # start, power, region, year, category, age, experience, bonus-malus
    state, reply = _run(session, ["старт", "90", "SOF", "2018", "B", "30", "8", "0"])
    assert state == DONE
    assert "Bulstrad (demo)" in reply.text
    assert "356.49" in reply.text  # cheapest shown
    # cheapest listed before pricier one
    assert reply.text.index("Bulstrad") < reply.text.index("Lev Ins")


def test_invalid_number_reasks_without_advancing(session):
    seed_demo(session)
    svc = ConversationService(lambda ri: compute_quotes(ri, session))
    t1 = svc.handle(START, {}, "старт")          # -> ASK_POWER
    t2 = svc.handle(t1.state, t1.context, "abc")  # invalid
    assert t2.state == t1.state == "ASK_POWER"
    assert "число" in t2.reply.text


def test_cancel_resets(session):
    seed_demo(session)
    svc = ConversationService(lambda ri: compute_quotes(ri, session))
    t1 = svc.handle(START, {}, "старт")
    t2 = svc.handle(t1.state, t1.context, "отказ")
    assert t2.state == START
    assert t2.context == {}
