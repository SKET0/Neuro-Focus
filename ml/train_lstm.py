"""Train and test the Neuro-Focus attention model (a small LSTM) on recorder files.

The recorder (pages/model-data.html) saves one CSV per person. Put them in ml/data/, then:

    ml/.venv/bin/python ml/train_lstm.py ml/data            # test only: writes ml/results/
    ml/.venv/bin/python ml/train_lstm.py ml/data --export   # also saves the model for the website

Testing is leave-one-person-out: each person is tested by a model trained only on everyone
else, so the numbers show how the model does on someone it has never seen. The app's current
rules are scored on exactly the same windows for comparison.

Calibration: people differ in ways that have nothing to do with attention (how open their eyes
look, how far they sit, where the camera points). So four readings are measured against the
person's own baseline: the median of their first 20 seconds looking at the screen (the
recorder's "calibrate" step; older recordings use the first 20 s of their first reading task).
The app does the same: 20 seconds of "look at your screen" when tracking starts.
"""
import argparse
import csv
import itertools
import json
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import torch
from torch import nn

# Must match TRACKER_VERSION and FEATURE_NAMES in scripts/tracking/gaze-reading.js.
TRACKER_VERSION = "2"
FEATURES = ["gaze_x", "gaze_y", "eye_open", "head_turn", "face_size", "head_yaw", "head_pitch", "head_roll"]
TASKS = ["read", "dot", "phone", "away", "tired"]
TASK_TITLES = {"read": "Read the text", "dot": "Follow the dot", "phone": "Use your phone", "away": "Look away", "tired": "Act tired"}

READING_MS = 120     # the tracker takes a reading every 120 ms
WINDOW = 16          # readings the model looks at (about 2 seconds)
STRIDE = 4           # a new window every 4 readings
SETTLE_MS = 1000     # skip each task's first second, while people are still moving
MAX_GAP_MS = 600     # a longer gap with no usable reading starts a new run, like the app
HIDDEN = 24          # LSTM size
EPOCHS = 40
BATCH = 64
LEARNING_RATE = 0.005
SEED = 7
CALIBRATED = ["face_size", "eye_open", "gaze_y", "head_pitch"]  # measured against the person's baseline
CALIBRATION_MS = 20000      # how long the baseline is measured for
MIN_CALIBRATION = 40        # usable readings needed for a baseline (about 5 s)
# How the app smooths the model's answers (createScoreSmoother in scripts/tracking/attention-model.js):
# averaged over about 3 s, and switching to not focused below 40%, back to focused above 60%.
SMOOTH_SECONDS = 3
SMOOTH_LOW, SMOOTH_HIGH = 0.4, 0.6

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "ml" / "results"
MODEL_FILE = ROOT / "assets" / "models" / "attention-lstm.json"


# ---------- Data ----------
def load_rows(folder):
    files, rows = [], []
    for path in sorted(Path(folder).glob("*.csv")):
        with open(path, newline="") as f:
            reader = csv.DictReader(f)
            missing = [name for name in FEATURES + ["participant", "task", "label", "t_ms", "usable"] if name not in (reader.fieldnames or [])]
            if missing:
                sys.exit(f"{path.name} is missing columns: {', '.join(missing)}")
            mine = list(reader)
        # Older recorders measured some readings differently; mixing them would confuse the model.
        if not mine or mine[0].get("tracker_version") != TRACKER_VERSION:
            print(f"Skipping {path.name}: recorded with an older version of the tracker. Record it again.")
            continue
        files.append(path)
        rows.extend(mine)
    return files, rows


def baselines(rows):
    """Each recording's baseline: the median of the CALIBRATED readings over its calibration step
    (task "calibrate"), or, in recordings made before that step existed, over the first 20 s of
    its first reading task. Keyed by (participant, session)."""
    calibration, fallback = defaultdict(list), defaultdict(list)
    for row in rows:
        if row["usable"] != "1" or any(row[name] == "" for name in FEATURES):
            continue
        key = (row["participant"], row["session"])
        if row["task"] == "calibrate":
            calibration[key].append(row)
        elif row["task"] == "read" and row["round"] == "1" and int(row["t_ms"]) < CALIBRATION_MS:
            fallback[key].append(row)
    result = {}
    for key in set(calibration) | set(fallback):
        source = calibration[key] if len(calibration[key]) >= MIN_CALIBRATION else fallback[key]
        if len(source) < MIN_CALIBRATION:
            print(f"Warning: {key[0]} has only {len(source)} usable calibration readings.")
        if source:
            result[key] = {name: float(np.median([float(row[name]) for row in source])) for name in CALIBRATED}
    return result


def calibrate(rows, base):
    """The rows with the CALIBRATED readings measured against each recording's baseline."""
    out = []
    for row in rows:
        b = base.get((row["participant"], row["session"]))
        if b and row["usable"] == "1" and all(row[name] != "" for name in FEATURES):
            row = dict(row)
            for name in CALIBRATED:
                row[name] = str(float(row[name]) - b[name])
        out.append(row)
    return out


def make_windows(rows):
    """Cut each task into 2-second windows of usable readings.

    Unusable readings (no face, eyes not visible, ...) are gaps, never inputs: the app shows
    "Tracking unavailable" for them instead of a score, so the model never scores them either.
    """
    segments = defaultdict(list)
    for row in rows:
        if row["task"] in TASKS:  # the calibration step is not a task to score
            segments[(row["participant"], row["session"], row["round"], row["task"])].append(row)

    windows = []
    for (participant, session, _, task), segment in segments.items():
        segment.sort(key=lambda row: int(row["t_ms"]))
        runs, run, last_t = [], [], None
        for row in segment:
            t = int(row["t_ms"])
            if t < SETTLE_MS or row["usable"] != "1" or any(row[name] == "" for name in FEATURES):
                continue
            if last_t is not None and t - last_t > MAX_GAP_MS:
                runs.append(run)
                run = []
            run.append(row)
            last_t = t
        runs.append(run)

        for run in runs:
            for start in range(0, len(run) - WINDOW + 1, STRIDE):
                part = run[start:start + WINDOW]
                last = part[-1]
                windows.append({
                    "x": [[float(row[name]) for name in FEATURES] for row in part],
                    "focused": int(last["label"]),
                    "participant": participant,
                    "session": session,
                    "task": task,
                    "round": last["round"],
                    "rule_focused": 1 if last.get("rule_engagement") == "on-screen" else 0,
                    "rule_score": float(last["rule_score"]) if last.get("rule_score") else np.nan,
                })
    return windows


def as_arrays(windows):
    X = np.array([w["x"] for w in windows], dtype=np.float32)
    y = np.array([w["focused"] for w in windows], dtype=np.float32)
    return X, y


# ---------- Model ----------
class AttentionLSTM(nn.Module):
    def __init__(self, n_features=len(FEATURES), hidden=HIDDEN):
        super().__init__()
        self.lstm = nn.LSTM(n_features, hidden, batch_first=True)
        self.out = nn.Linear(hidden, 1)

    def forward(self, x):
        _, (h, _) = self.lstm(x)               # h: the LSTM's state after the last reading
        return self.out(h[-1]).squeeze(-1)     # a logit: above 0 means focused


def normaliser(X):
    flat = X.reshape(-1, X.shape[-1])
    return flat.mean(axis=0), np.maximum(flat.std(axis=0), 1e-6)


# Readings that change sign (or flip around 0.5) when someone looks the other way.
MIRRORED = {"gaze_x": lambda v: 1 - v, "head_turn": lambda v: -v, "head_yaw": lambda v: -v, "head_roll": lambda v: -v}


def with_mirrored(X, y):
    """Add a left-right mirrored copy of every window: looking left is as distracted as looking
    right, so a person who only turned one way while recording still teaches both."""
    flipped = X.copy()
    for name, flip in MIRRORED.items():
        i = FEATURES.index(name)
        flipped[..., i] = flip(flipped[..., i])
    return np.concatenate([X, flipped]), np.concatenate([y, y])


def train(X, y, seed=SEED):
    torch.manual_seed(seed)
    model = AttentionLSTM()
    optimiser = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    focused_share = float(y.mean())
    # Weigh the classes equally, even when one has more windows.
    weight = (1 - focused_share) / focused_share if 0 < focused_share < 1 else 1.0
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(weight))
    Xt, yt = torch.from_numpy(X), torch.from_numpy(y)
    order_gen = torch.Generator().manual_seed(seed)
    model.train()
    for _ in range(EPOCHS):
        order = torch.randperm(len(Xt), generator=order_gen)
        for i in range(0, len(order), BATCH):
            batch = order[i:i + BATCH]
            optimiser.zero_grad()
            loss = loss_fn(model(Xt[batch]), yt[batch])
            loss.backward()
            optimiser.step()
    model.eval()
    return model


def predict(model, X):
    with torch.no_grad():
        return torch.sigmoid(model(torch.from_numpy(X))).numpy()


# ---------- Scores ----------
def scores(focused, predicted, probability=None):
    """Distracted is the class we want to catch, so precision/recall/F1 are for 'distracted'."""
    focused = np.asarray(focused).astype(int)
    predicted = np.asarray(predicted).astype(int)
    tp = int(((predicted == 0) & (focused == 0)).sum())   # distracted, caught
    fn = int(((predicted == 1) & (focused == 0)).sum())   # distracted, missed
    fp = int(((predicted == 0) & (focused == 1)).sum())   # focused, wrongly flagged
    tn = int(((predicted == 1) & (focused == 1)).sum())   # focused, correct
    def ratio(a, b):
        return a / b if b else float("nan")
    recall, precision = ratio(tp, tp + fn), ratio(tp, tp + fp)
    focused_recall = ratio(tn, tn + fp)
    result = {
        "windows": len(focused),
        "accuracy": ratio(tp + tn, len(focused)),
        "balanced_accuracy": np.nanmean([recall, focused_recall]),
        "distracted_recall": recall,
        "distracted_precision": precision,
        "focused_recall": focused_recall,
        "distracted_f1": ratio(2 * precision * recall, precision + recall),
        "confusion": {"focused_as_focused": tn, "focused_as_distracted": fp, "distracted_as_focused": fn, "distracted_as_distracted": tp},
    }
    if probability is not None:
        result["auc"] = auc(focused, probability)
    return result


def auc(focused, probability):
    """Chance that a random focused window gets a higher score than a random distracted one."""
    probability = np.asarray(probability, dtype=float)
    keep = ~np.isnan(probability)
    focused, probability = np.asarray(focused)[keep], probability[keep]
    pos, neg = probability[focused == 1], probability[focused == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    values = np.concatenate([pos, neg])
    ranks = np.empty(len(values))
    ranks[values.argsort(kind="stable")] = np.arange(1, len(values) + 1)
    _, group, counts = np.unique(values, return_inverse=True, return_counts=True)
    ranks = (np.bincount(group, weights=ranks) / counts)[group]  # equal scores share their average rank
    return float((ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


# ---------- Testing ----------
def evaluate(windows):
    people = sorted({w["participant"] for w in windows})
    if len(people) >= 2:
        method = f"Leave one person out ({len(people)} people)"
        folds = [([w for w in windows if w["participant"] != p], [w for w in windows if w["participant"] == p]) for p in people]
    else:
        method = "Train on round 1, test on round 2 (only one person: says little about new people)"
        folds = [([w for w in windows if w["round"] == "1"], [w for w in windows if w["round"] == "2"])]

    tested, probabilities = [], []
    for train_windows, test_windows in folds:
        if not train_windows or not test_windows:
            continue
        X_train, y_train = with_mirrored(*as_arrays(train_windows))
        mean, std = normaliser(X_train)
        model = train((X_train - mean) / std, y_train)
        X_test, _ = as_arrays(test_windows)
        probabilities.extend(predict(model, (X_test - mean) / std).tolist())
        tested.extend(test_windows)
    return method, tested, np.array(probabilities)


def compare(tested, probabilities):
    focused = np.array([w["focused"] for w in tested])
    lstm_pred = (probabilities >= 0.5).astype(int)
    rule_pred = np.array([w["rule_focused"] for w in tested])
    rule_score = np.array([w["rule_score"] for w in tested])
    overall = {"lstm": scores(focused, lstm_pred, probabilities), "rules": scores(focused, rule_pred, rule_score)}

    by_task = {}
    for task in TASKS:
        mask = np.array([w["task"] == task for w in tested])
        if mask.any():
            by_task[task] = {
                "windows": int(mask.sum()),
                "lstm": float((lstm_pred[mask] == focused[mask]).mean()),
                "rules": float((rule_pred[mask] == focused[mask]).mean()),
            }

    by_person = {}
    for person in sorted({w["participant"] for w in tested}):
        mask = np.array([w["participant"] == person for w in tested])
        by_person[person] = {
            "windows": int(mask.sum()),
            "lstm": scores(focused[mask], lstm_pred[mask])["balanced_accuracy"],
            "rules": scores(focused[mask], rule_pred[mask])["balanced_accuracy"],
        }
    return overall, by_task, by_person


# ---------- Report ----------
def over_time(tested, probabilities):
    """How each method behaves over time within a task, as a student would see it: how far the score
    moves from one window to the next (about 0.5 s apart) and how often focused / not focused
    switches, plus accuracy. The LSTM is shown raw and smoothed the way the app smooths it."""
    step = STRIDE * READING_MS / 1000
    focused = np.array([w["focused"] for w in tested])
    groups = [list(g) for _, g in itertools.groupby(range(len(tested)), key=lambda i: (tested[i]["participant"], tested[i]["round"], tested[i]["task"]))]

    smoothed_score, smoothed_state = np.zeros(len(tested)), np.zeros(len(tested), dtype=bool)
    alpha = 1 - math.exp(-step / SMOOTH_SECONDS)
    for group in groups:
        value, state = None, None
        for i in group:
            if value is None:
                value, state = probabilities[i], probabilities[i] >= 0.5
            else:
                value += alpha * (probabilities[i] - value)
                state = (value >= SMOOTH_LOW) if state else (value > SMOOTH_HIGH)
            smoothed_score[i], smoothed_state[i] = value * 100, state

    def describe(score, state):
        changes, switches, minutes = [], 0, 0.0
        for group in groups:
            changes += list(np.abs(np.diff(score[group])))
            switches += int(np.sum(state[group][1:] != state[group][:-1]))
            minutes += len(group) * step / 60
        left_alone, caught = float(state[focused == 1].mean()), float((~state[focused == 0]).mean())
        return {"focused_left_alone": left_alone, "distracted_caught": caught, "balanced_accuracy": (left_alone + caught) / 2,
                "score_change": float(np.mean(changes)), "switches_per_minute": switches / minutes}

    rules_score = np.nan_to_num(np.array([w["rule_score"] for w in tested]))
    rules_state = np.array([w["rule_focused"] for w in tested]).astype(bool)
    return {
        "rules": describe(rules_score, rules_state),
        "lstm_raw": describe(probabilities * 100, probabilities >= 0.5),
        "lstm_smoothed": describe(smoothed_score, smoothed_state),
    }


def pct(value):
    return "—" if value is None or value != value else f"{value * 100:.1f}%"


def data_summary(files, rows, windows):
    people = sorted({row["participant"] for row in rows})
    lines = [f"- Files: {len(files)}, people: {len(people)} ({', '.join(people)}), readings: {len(rows)}, windows: {len(windows)}", "",
             "| Task | Label | Readings | Face measurable | Windows |", "|---|---|---|---|---|"]
    for task in TASKS:
        mine = [row for row in rows if row["task"] == task]
        if not mine:
            continue
        usable = sum(row["usable"] == "1" for row in mine) / len(mine)
        label = "focused" if mine[0]["label"] == "1" else "distracted"
        count = sum(w["task"] == task for w in windows)
        lines.append(f"| {TASK_TITLES[task]} | {label} | {len(mine)} | {pct(usable)} | {count} |")
    return lines


def report(files, rows, windows, method, overall, by_task, by_person, timing):
    lstm, rules = overall["lstm"], overall["rules"]
    lines = [
        "# Attention model: test results", "",
        f"Generated by `ml/train_lstm.py` on {date.today().isoformat()}. These numbers come from acted tasks recorded with `pages/model-data.html`; they show how well each method separates those tasks, not real-classroom accuracy.", "",
        "## Data", "", *data_summary(files, rows, windows), "",
        "## Method", "",
        f"- Features per reading ({len(FEATURES)}): {', '.join(FEATURES)}",
        f"- Window: {WINDOW} readings (about {WINDOW * READING_MS / 1000:.1f} s), a new window every {STRIDE} readings; each task's first {SETTLE_MS / 1000:.0f} s skipped; unusable readings are gaps, never inputs",
        f"- Model: LSTM ({HIDDEN} units) then one output (probability of focused); {EPOCHS} epochs, Adam, learning rate {LEARNING_RATE}, classes weighted equally; every training window also used left-right mirrored",
        f"- Calibration: {', '.join(CALIBRATED)} measured against each person's median over their first {CALIBRATION_MS // 1000} s looking at the screen",
        f"- Testing: {method}",
        "- Rules: the app's current rule-based estimate (on-screen / looking-away) on the same windows", "",
        "## LSTM compared with the current rules", "",
        "| Measure | LSTM | Rules |", "|---|---|---|",
    ]
    for key, name in [("accuracy", "Accuracy"), ("balanced_accuracy", "Balanced accuracy"), ("distracted_recall", "Distracted caught (recall)"),
                      ("distracted_precision", "Distracted flags that were right (precision)"), ("focused_recall", "Focused correctly left alone"),
                      ("distracted_f1", "F1 (distracted)"), ("auc", "AUC (score ranking)")]:
        lines.append(f"| {name} | {pct(lstm.get(key))} | {pct(rules.get(key))} |")
    lines += ["", f"Windows tested: {lstm['windows']}.", "", "## Accuracy by task", "", "| Task | Windows | LSTM | Rules |", "|---|---|---|---|"]
    for task, row in by_task.items():
        lines.append(f"| {TASK_TITLES[task]} | {row['windows']} | {pct(row['lstm'])} | {pct(row['rules'])} |")
    heading = "tested on a model that never saw them" if method.startswith("Leave one person out") else "tested on round 2 only"
    lines += ["", f"## Balanced accuracy by person ({heading})", "", "| Person | Windows | LSTM | Rules |", "|---|---|---|---|"]
    for person, row in by_person.items():
        lines.append(f"| {person} | {row['windows']} | {pct(row['lstm'])} | {pct(row['rules'])} |")
    lines += ["", "## Over time (as the app shows it)", "",
              f"The model's raw answer is usually very sure either way, so it jumps; the app averages it over about {SMOOTH_SECONDS} s and only switches to not focused below {SMOOTH_LOW:.0%} and back above {SMOOTH_HIGH:.0%}. Score change is the average move from one moment to the next (about {STRIDE * READING_MS / 1000:.1f} s apart, in points out of 100).", "",
              "| | Rules | LSTM (raw) | LSTM (smoothed, as in the app) |", "|---|---|---|---|"]
    for key, name, fmt in [("focused_left_alone", "Focused correctly left alone", pct), ("distracted_caught", "Distracted caught", pct),
                           ("balanced_accuracy", "Balanced accuracy", pct), ("score_change", "Score change between moments", lambda v: f"{v:.1f}"),
                           ("switches_per_minute", "Focused / not focused switches per minute", lambda v: f"{v:.1f}")]:
        lines.append(f"| {name} | {fmt(timing['rules'][key])} | {fmt(timing['lstm_raw'][key])} | {fmt(timing['lstm_smoothed'][key])} |")
    lines += ["", "## Confusion (windows)", "", "| | Predicted focused | Predicted distracted |", "|---|---|---|"]
    for name, result in [("LSTM", lstm), ("Rules", rules)]:
        c = result["confusion"]
        lines.append(f"| {name}: actually focused | {c['focused_as_focused']} | {c['focused_as_distracted']} |")
        lines.append(f"| {name}: actually distracted | {c['distracted_as_focused']} | {c['distracted_as_distracted']} |")
    return "\n".join(lines) + "\n"


# ---------- Export for the website ----------
def export(windows, overall, method, base):
    X, y = as_arrays(windows)
    X_all, y_all = with_mirrored(X, y)
    mean, std = normaliser(X_all)
    model = train((X_all - mean) / std, y_all)

    # Round the weights, then load them back so the check values match the saved file exactly.
    state = {name: torch.round(value * 1e6) / 1e6 for name, value in model.state_dict().items()}
    model.load_state_dict(state)
    mean, std = np.round(mean, 6), np.round(std, 6)

    # Check values for the website's own LSTM code: a few windows and what PyTorch gives for them.
    rng = np.random.default_rng(SEED)
    picks = rng.choice(len(X), size=min(4, len(X)), replace=False)
    # The logit (score before the sigmoid) is checked too: probabilities near 0 or 1 hide small errors.
    check = []
    for i in picks:
        x = ((np.round(X[i], 6) - mean) / std)[None].astype(np.float32)
        with torch.no_grad():
            logit = float(model(torch.from_numpy(x))[0])
        # The readings as the tracker gives them (before calibration) and the baseline, so the
        # website's test also checks that it applies the baseline the same way.
        b = base[(windows[i]["participant"], windows[i]["session"])]
        offsets = np.array([b.get(name, 0.0) for name in FEATURES])
        raw = np.round(np.round(X[i], 6) + offsets, 6)
        check.append({"input": raw.tolist(), "baseline": {name: round(b[name], 6) for name in CALIBRATED},
                      "calibrated": np.round(X[i], 6).tolist(), "focused_logit": logit, "focused_probability": float(predict(model, x)[0])})

    hidden = HIDDEN
    data = {
        "format": "neurofocus-attention-lstm-1",
        "trained": date.today().isoformat(),
        "tracker_version": int(TRACKER_VERSION),
        "features": FEATURES,
        "window": WINDOW,
        "reading_ms": READING_MS,
        "threshold": 0.5,
        # Measure these readings against the person's baseline: the median of their first
        # `seconds` of usable readings while looking at the screen (at least `min_readings`).
        "calibration": {"features": CALIBRATED, "seconds": CALIBRATION_MS // 1000, "min_readings": MIN_CALIBRATION},
        "mean": mean.tolist(),
        "std": std.tolist(),
        "hidden": hidden,
        # PyTorch layout: rows are the gates in the order input, forget, cell, output.
        "lstm": {
            "weight_ih": state["lstm.weight_ih_l0"].tolist(),
            "weight_hh": state["lstm.weight_hh_l0"].tolist(),
            "bias": (state["lstm.bias_ih_l0"] + state["lstm.bias_hh_l0"]).tolist(),
        },
        "output": {"weight": state["out.weight"][0].tolist(), "bias": float(state["out.bias"][0])},
        "evaluation": {
            "method": method,
            "people": len({w["participant"] for w in windows}),
            "windows": len(windows),
            "lstm": {k: v for k, v in overall["lstm"].items() if k != "confusion"},
            "rules": {k: v for k, v in overall["rules"].items() if k != "confusion"},
        },
        "check": check,
    }
    MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    MODEL_FILE.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False, default=lambda v: None))
    return MODEL_FILE


def clean(value):
    """NaN is not valid JSON."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, float) and value != value:
        return None
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data", help="folder of recorder CSV files")
    parser.add_argument("--export", action="store_true", help=f"also train on everything and save {MODEL_FILE.relative_to(ROOT)}")
    args = parser.parse_args()

    files, rows = load_rows(args.data)
    if not rows:
        sys.exit(f"No recordings to use in {args.data}")
    base = baselines(rows)
    windows = make_windows(calibrate(rows, base))
    if len({w["focused"] for w in windows}) < 2:
        sys.exit("Need both focused and distracted windows to train.")

    method, tested, probabilities = evaluate(windows)
    overall, by_task, by_person = compare(tested, probabilities)
    timing = over_time(tested, probabilities)
    text = report(files, rows, windows, method, overall, by_task, by_person, timing)

    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "report.md").write_text(text)
    (RESULTS / "results.json").write_text(json.dumps(clean({"method": method, "overall": overall, "by_task": by_task, "by_person": by_person, "over_time": timing}), indent=2))
    print(text)
    print(f"Saved {RESULTS.relative_to(ROOT)}/report.md and results.json")

    if args.export:
        overall = clean(overall)
        path = export(windows, overall, method, base)
        print(f"Saved the model for the website: {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
