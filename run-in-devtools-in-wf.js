(async function() {
	var resultIdMap = new Map();
	var mirrors = new Map();

	function ensureChildren(node) {
		return Array.isArray(node.children) ? node.children : [];
	}

	function processNode(node) {
		var result = resultIdMap.get(node.id) || {};
		resultIdMap.set(node.id, result);
		result.id = node.id;
		result.name = node.name || "";
		result.note = node.note || "";
		result.completed = Boolean(node.completed);
		result.lastModified = node.lastModified;
		node.mirrorRootItems?.forEach(function(item) {
			mirrors.set(item.id, node.id);
		});
		result.children = ensureChildren(node).map(processNode);
		return result;
	}

	function parseInternalLinkId(href) {
		if (!href) return null;

		var patterns = [
			/#\/([a-f0-9]{12})\b/i,
			/[?&]q=([a-f0-9]{12})\b/i,
			/\b([a-f0-9]{12})\b/i
		];

		for (var i = 0; i < patterns.length; i += 1) {
			var match = href.match(patterns[i]);
			if (match) return match[1];
		}

		return null;
	}

	function markInternalLinks(html) {
		if (!html) return "";

		var container = document.createElement("div");
		container.innerHTML = html;
		container.querySelectorAll("a[href]").forEach(function(anchor) {
			var href = anchor.getAttribute("href") || "";
			if (!/workflowy\.com/i.test(href)) return;
			var linkId = parseInternalLinkId(href);
			if (!linkId) return;
			anchor.setAttribute("data-workflowy-link-id", linkId);
		});
		return container.innerHTML;
	}

	function repeat(str, count) {
		return new Array(count + 1).join(str);
	}

	function collapseWhitespace(text) {
		return text.replace(/\s+/g, " ");
	}

	function htmlToMarkdown(html) {
		if (!html) return "";

		var container = document.createElement("div");
		container.innerHTML = markInternalLinks(html);

		function renderChildren(node, context) {
			var output = "";
			for (var i = 0; i < node.childNodes.length; i += 1) {
				output += renderNode(node.childNodes[i], context);
			}
			return output;
		}

		function renderList(listNode, depth, ordered) {
			var lines = [];
			var index = 1;
			Array.prototype.forEach.call(listNode.children, function(child) {
				if (child.nodeName !== "LI") return;
				lines.push(renderListItem(child, depth, ordered ? index + "." : "-"));
				index += 1;
			});
			return lines.join("\n");
		}

		function renderListItem(itemNode, depth, marker) {
			var prefix = repeat("  ", depth) + marker + " ";
			var inlineParts = [];
			var nestedParts = [];

			for (var i = 0; i < itemNode.childNodes.length; i += 1) {
				var child = itemNode.childNodes[i];
				if (child.nodeName === "UL" || child.nodeName === "OL") {
					nestedParts.push(renderList(child, depth + 1, child.nodeName === "OL"));
				} else {
					inlineParts.push(renderNode(child, { preserveNewlines: false }));
				}
			}

			var firstLine = prefix + collapseWhitespace(inlineParts.join("")).trim();
			var parts = [firstLine];
			if (nestedParts.length) {
				parts.push(nestedParts.join("\n"));
			}
			return parts.join("\n");
		}

		function renderNode(node, context) {
			if (node.nodeType === Node.TEXT_NODE) {
				return context && context.preserveNewlines ? node.textContent : collapseWhitespace(node.textContent);
			}

			if (node.nodeType !== Node.ELEMENT_NODE) {
				return "";
			}

			var tag = node.nodeName;
			if (tag === "BR") return "\n";
			if (tag === "HR") return "\n---\n";
			if (tag === "STRONG" || tag === "B") return "**" + renderChildren(node, context) + "**";
			if (tag === "EM" || tag === "I") return "*" + renderChildren(node, context) + "*";
			if (tag === "CODE") return "`" + renderChildren(node, context).trim() + "`";
			if (tag === "PRE") return "\n```\n" + node.textContent.replace(/\n+$/, "") + "\n```\n";
			if (tag === "A") {
				var text = collapseWhitespace(renderChildren(node, context)).trim() || "link";
				var href = node.getAttribute("href") || "";
				var linkId = node.getAttribute("data-workflowy-link-id");
				if (linkId) return text + " (WF link to " + linkId + ")";
				return "[" + text + "](" + href + ")";
			}
			if (tag === "UL") return "\n" + renderList(node, 0, false) + "\n";
			if (tag === "OL") return "\n" + renderList(node, 0, true) + "\n";
			if (tag === "LI") return renderListItem(node, 0, "-");
			if (tag === "BLOCKQUOTE") {
				return "\n" + renderChildren(node, { preserveNewlines: true }).split("\n").map(function(line) {
					return line ? "> " + line : ">";
				}).join("\n") + "\n";
			}
			if (tag === "P" || tag === "DIV") {
				var blockText = renderChildren(node, { preserveNewlines: true }).trim();
				return blockText ? blockText + "\n\n" : "";
			}

			return renderChildren(node, context);
		}

		var markdown = renderChildren(container, { preserveNewlines: true });
		return markdown
			.replace(/\r\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]+\n/g, "\n")
			.trim();
	}

	function normalizeTree(node) {
		return {
			id: node.id,
			nameMarkdown: htmlToMarkdown(node.name),
			noteMarkdown: htmlToMarkdown(node.note),
			completed: node.completed,
			mirrorRootId: node.mirrorRootId,
			mirrorRootName: node.mirrorRootName,
			children: ensureChildren(node).map(function(child) {
				return normalizeTree(child);
			})
		};
	}

	function slugifyFileName(name, fallback) {
		var safeName = (name || "")
			.replace(/[\\/:*?"<>|]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return (safeName || fallback) + ".md";
	}

	function sanitizePageName(name, fallback) {
		var pageName = (name || "")
			.replace(/\[\[|\]\]/g, "")
			.replace(/#/g, "")
			.replace(/\s+/g, " ")
			.trim();
		return pageName || fallback;
	}

	function indentLines(text, depth) {
		var prefix = new Array(depth + 1).join("\t");
		return text.split("\n").map(function(line) {
			return prefix + line;
		}).join("\n");
	}

	function renderNote(noteMarkdown, depth) {
		if (!noteMarkdown) return [];

		var lines = noteMarkdown.split("\n");
		var rendered = [];
		for (var i = 0; i < lines.length; i += 1) {
			var line = lines[i].trim();
			rendered.push(indentLines("- " + (line || ""), depth));
		}
		return rendered;
	}

	function renderNode(node, depth) {
		var title = node.nameMarkdown || ("Untitled block " + node.id);
		var lines = [];

		if (node.mirrorRootId) {
			title += " [Mirror of " + (node.mirrorRootName || node.mirrorRootId) + " (" + node.mirrorRootId + ")]";
		}

		if (node.completed) {
			title = "DONE " + title;
		}

		lines.push(indentLines("- " + title, depth));
		lines = lines.concat(renderNote(node.noteMarkdown, depth + 1));

		ensureChildren(node).forEach(function(child) {
			lines = lines.concat(renderNode(child, depth + 1));
		});

		return lines;
	}

	function renderPage(rootNode, index) {
		var pageName = sanitizePageName(rootNode.nameMarkdown, "Imported Page " + index);
		var header = ["title:: " + pageName, ""];
		var body = [];

		if (rootNode.noteMarkdown) {
			body = body.concat(renderNote(rootNode.noteMarkdown, 0));
		}

		ensureChildren(rootNode).forEach(function(child) {
			body = body.concat(renderNode(child, 0));
		});

		if (!body.length) {
			body = renderNode(rootNode, 0);
		}

		return {
			pageName: pageName,
			fileName: slugifyFileName(pageName, "Imported Page " + index),
			content: header.concat(body).join("\n").trim() + "\n"
		};
	}

	function downloadFile(file) {
		var blob = new Blob([file.content], { type: "text/markdown;charset=utf-8" });
		var url = URL.createObjectURL(blob);
		var anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = file.fileName;
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		setTimeout(function() {
			URL.revokeObjectURL(url);
		}, 1000);
	}

	var currentRoot = processNode(WF.currentItem().data);
	var exportRoots = ensureChildren(currentRoot);

	mirrors.forEach(function(rootId, mirrorId) {
		var mirroredItem = resultIdMap.get(mirrorId);
		var mirrorRoot = resultIdMap.get(rootId);
		if (!mirroredItem || !mirrorRoot) return;
		mirroredItem.mirrorRootId = rootId;
		mirroredItem.mirrorRootName = mirrorRoot.name;
		mirroredItem.children = [];
	});

	var normalizedRoots = (exportRoots.length ? exportRoots : [currentRoot]).map(function(node) {
		return normalizeTree(node);
	});
	var files = normalizedRoots.map(renderPage);

	files.forEach(downloadFile);

	console.log("Exported Logseq pages:", files.map(function(file) {
		return file.fileName;
	}));
})();
