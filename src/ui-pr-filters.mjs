export function projectsOf(pullRequests) {
    return [...new Set(pullRequests.map((pr) => pr.repository))]
      .sort((left, right) => left.localeCompare(right));
  }

export function keepKnownProjects(selectedProjects, projects) {
    return new Set([...selectedProjects].filter((project) => projects.includes(project)));
  }

export function sameProjectOptions(options, projects) {
    return projects.length === options.length
      && projects.every((project, index) => options[index].value === project);
  }

export function boardView(pullRequests, selectedProjects, humanOnly) {
    const projectFiltered = selectedProjects.size === 0
      ? pullRequests
      : pullRequests.filter((pr) => selectedProjects.has(pr.repository));
    const needsHuman = projectFiltered.filter((pr) => pr.decision.state === 'needs_human');
    return { projectFiltered, needsHuman, visible: humanOnly ? needsHuman : projectFiltered };
  }

export const PR_FILTER_SOURCE = [projectsOf.toString(), keepKnownProjects.toString(), sameProjectOptions.toString(), boardView.toString()].join("\n");
