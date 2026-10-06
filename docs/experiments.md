# Organize experiments

[← README](../README.md) · [Set up runs](runs.md) · [Compare results](comparison.md)

An **experiment** is a named group of evaluation runs. Use one when you want to try several models or instructions for the same question, such as “Which prompt extracts receipt totals most accurately?” Each run still keeps its own results and settings.

## Start an experiment

1. Open **Experiments**, select **New experiment**, and give it a short name, such as **Receipt total extraction**.
2. Select **New run in this experiment**. Setup opens with the experiment already chosen.
3. Walk through the steps and select **Run evaluation**. The new run appears under the experiment.
4. Change a model or instruction and run again with the same experiment selected.

You can also create an experiment on the **Review & run** step while preparing a run. Experiment selection groups the new run; it does not change the model request or grading rules. If you leave the selection empty, the run stays ungrouped. Existing and terminal-started runs remain ungrouped unless you assign them from the Experiments page.

## Organize existing runs

Select an experiment and choose **Add existing runs** to pick ungrouped runs. You can remove a run from its group without deleting its results. Use the **⋯** menu to rename an experiment or delete it; deleting keeps its runs and makes them ungrouped.

Tick two runs in an experiment and select **Compare selected** to open them in Compare.

## Compare results

Grouping runs does not make them automatically comparable. **Compare** still requires graded runs with a matching dataset version and compatible schema, grading rules, extraction source, and tool settings. Model targets and prompts may differ. [Comparison guide](comparison.md) explains these checks.
