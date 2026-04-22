(async function() {
	var resultIdMap = new Map();
	var mirrors = new Map();
	var IMAGE_PLACEHOLDER_PREFIX = "__WF_IMAGE_ASSET_";

	function ensureChildren(node) {
		return Array.isArray(node.children) ? node.children : [];
	}

	function processNode(node) {
		var result = resultIdMap.get(node.id) || {};
		resultIdMap.set(node.id, result);
		result.id = node.id;
		result.name = node.name || "";
		result.note = node.note || "";
		result.imageSources = extractImageSourcesFromNodeData(node);
		result.imageMeta = extractImageMetaFromNodeData(node);
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

	function escapeMarkdownImageText(text) {
		return (text || "").replace(/[\[\]]/g, "");
	}

	function extractUrlFromCssValue(value) {
		if (!value) return "";
		var match = value.match(/url\((['"]?)(.*?)\1\)/i);
		return match ? match[2] : "";
	}

	function normalizeImageSource(src) {
		if (!src) return "";
		if (/^\/\//.test(src)) return window.location.protocol + src;
		if (/^\//.test(src)) return window.location.origin + src;
		return src;
	}

	function isLikelyImageSource(value) {
		return /(?:\/(?:file-proxy|signed-preview)[^"'()\s]*|data:image\/|blob:|https?:\/\/[^"'()\s]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#][^"'()\s]*)?)/i.test(value || "");
	}

	function extractImageSourcesFromText(value) {
		if (!value) return [];

		var patterns = [
			/(https?:\/\/[^"'()\s]+\/(?:file-proxy|signed-preview)[^"'()\s]*)/ig,
			/(\/(?:file-proxy|signed-preview)[^"'()\s]*)/ig,
			/(https?:\/\/[^"'()\s]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#][^"'()\s]*)?)/ig,
			/(data:image\/[^"'()\s]+)/ig,
			/(blob:[^"'()\s]+)/ig
		];

		var results = [];
		patterns.forEach(function(pattern) {
			var match;
			while ((match = pattern.exec(value)) !== null) {
				results.push(normalizeImageSource(match[1]));
			}
		});
		return results;
	}

	function extractImageSourcesFromNodeData(node) {
		var found = new Set();
		var visited = typeof WeakSet === "function" ? new WeakSet() : null;

		function visit(value, depth) {
			if (value == null || depth > 6) return;

			if (typeof value === "string") {
				if (isLikelyImageSource(value)) {
					extractImageSourcesFromText(value).forEach(function(src) {
						found.add(src);
					});
				}
				return;
			}

			if (typeof value !== "object") return;
			if (visited) {
				if (visited.has(value)) return;
				visited.add(value);
			}

			if (Array.isArray(value)) {
				value.forEach(function(item) {
					visit(item, depth + 1);
				});
				return;
			}

			Object.keys(value).forEach(function(key) {
				if (key === "children" || key === "parent") return;
				visit(value[key], depth + 1);
			});
		}

		visit(node, 0);
		return Array.from(found);
	}

	function extractImageMetaFromNodeData(node) {
		var metadata = node && node.metadata;
		var s3File = metadata && metadata.s3File;
		if (!s3File || typeof s3File !== "object") return null;

		var fileType = typeof s3File.fileType === "string" ? s3File.fileType : "";
		if (!/^image\//i.test(fileType)) return null;

		var info = {
			fileName: typeof s3File.fileName === "string" ? s3File.fileName : "",
			fileType: fileType,
			sourceCandidates: []
		};

		if (typeof s3File.objectFolder === "string" && s3File.objectFolder) {
			info.sourceCandidates.push(
				window.location.origin + "/file-proxy/file/" + s3File.objectFolder
			);
			info.sourceCandidates.push(
				window.location.origin + "/file-proxy/file/" + encodeURIComponent(s3File.objectFolder)
			);
		}

		Object.keys(s3File).forEach(function(key) {
			var value = s3File[key];
			if (typeof value !== "string" || !value) return;

			if (isLikelyImageSource(value)) {
				extractImageSourcesFromText(value).forEach(function(src) {
					info.sourceCandidates.push(src);
				});
				return;
			}

			if (/(url|src|preview|thumb|proxy|download)/i.test(key) && /^(\/|https?:\/\/|blob:|data:image\/)/i.test(value)) {
				info.sourceCandidates.push(normalizeImageSource(value));
				return;
			}

			if (/(id|token|key|handle|objectFolder)/i.test(key) && /^[A-Za-z0-9+/_=-]{16,}$/.test(value)) {
				info.sourceCandidates.push(window.location.origin + "/file-proxy/file/" + value);
			}
		});

		extractSignedPreviewCandidates(node, s3File).forEach(function(src) {
			info.sourceCandidates.push(src);
		});

		info.sourceCandidates = Array.from(new Set(info.sourceCandidates));
		return info;
	}

	function extractProjectIdsFromValue(value, found, visited, depth) {
		if (value == null || depth > 4) return;

		if (typeof value === "number" && Number.isFinite(value)) {
			found.add(String(value));
			return;
		}

		if (typeof value === "string") {
			if (/^\d{3,}$/.test(value)) found.add(value);
			return;
		}

		if (typeof value !== "object") return;
		if (visited.has(value)) return;
		visited.add(value);

		if (Array.isArray(value)) {
			value.forEach(function(item) {
				extractProjectIdsFromValue(item, found, visited, depth + 1);
			});
			return;
		}

		Object.keys(value).slice(0, 40).forEach(function(key) {
			if (key === "children" || key === "parent") return;
			if (/project/i.test(key)) {
				var nestedValue = value[key];
				if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) {
					found.add(String(nestedValue));
				}
				if (typeof nestedValue === "string" && /^\d{3,}$/.test(nestedValue)) {
					found.add(nestedValue);
				}
			}
			extractProjectIdsFromValue(value[key], found, visited, depth + 1);
		});
	}

	function extractProjectIdsFromLocation() {
		var matches = [];
		var text = [
			window.location.href || "",
			window.location.pathname || "",
			window.location.hash || ""
		].join(" ");

		var pattern = /\b(\d{3,})\b/g;
		var match;
		while ((match = pattern.exec(text)) !== null) {
			matches.push(match[1]);
		}
		return matches;
	}

	function extractProjectIdsFromDom() {
		var matches = new Set();
		var selectors = [
			"[data-project-id]",
			"[data-projectid]",
			"[data-document-id]",
			"[data-doc-id]"
		];

		selectors.forEach(function(selector) {
			document.querySelectorAll(selector).forEach(function(element) {
				Array.prototype.forEach.call(element.attributes, function(attribute) {
					if (!/project|document|doc/i.test(attribute.name)) return;
					if (/^\d{3,}$/.test(attribute.value || "")) {
						matches.add(attribute.value);
					}
				});
			});
		});

		Array.prototype.forEach.call(document.querySelectorAll("*"), function(element) {
			if (matches.size >= 10) return;
			Array.prototype.forEach.call(element.attributes, function(attribute) {
				if (!/project|document|doc/i.test(attribute.name)) return;
				if (/^\d{3,}$/.test(attribute.value || "")) {
					matches.add(attribute.value);
				}
			});
		});

		return Array.from(matches);
	}

	function extractSignedPreviewInfoFromPerformance(nodeId) {
		var results = [];
		if (!window.performance || typeof window.performance.getEntriesByType !== "function") {
			return results;
		}

		var entries = window.performance.getEntriesByType("resource");
		entries.forEach(function(entry) {
			var name = entry && entry.name;
			if (typeof name !== "string" || name.indexOf("/file-proxy/signed-preview/") === -1) return;

			var match = name.match(/\/file-proxy\/signed-preview\/(\d+)\/([a-f0-9-]{36})\/(\d+x\d+)\//i);
			if (!match) return;

			results.push({
				projectId: match[1],
				nodeId: match[2],
				size: match[3],
				url: name
			});
		});

		if (nodeId) {
			var exactMatches = results.filter(function(item) {
				return item.nodeId === nodeId;
			});
			if (exactMatches.length) return exactMatches;
		}

		return results;
	}

	function extractSignedPreviewCandidates(node, s3File) {
		var candidates = [];
		var projectIds = new Set();
		var sizes = new Set();
		var visited = typeof WeakSet === "function" ? new WeakSet() : { has: function() { return false; }, add: function() {} };

		try {
			if (node && typeof node.getProjectReference === "function") {
				extractProjectIdsFromValue(node.getProjectReference(), projectIds, visited, 0);
			}
		} catch (error) {}

		try {
			if (node && typeof node.getProjectTree === "function") {
				extractProjectIdsFromValue(node.getProjectTree(), projectIds, visited, 0);
			}
		} catch (error) {}

		extractProjectIdsFromLocation().forEach(function(projectId) {
			projectIds.add(projectId);
		});

		extractProjectIdsFromDom().forEach(function(projectId) {
			projectIds.add(projectId);
		});

		extractSignedPreviewInfoFromPerformance(node && node.id).forEach(function(info) {
			if (info.projectId) projectIds.add(info.projectId);
			if (info.size) sizes.add(info.size);
			if (info.nodeId === node.id && info.url) candidates.push(info.url);
		});

		if (!projectIds.size || !node || !node.id) return candidates;

		var width = Math.max(1, Math.min(Number(s3File.imageOriginalWidth) || 800, 2000));
		var height = Math.max(1, Math.min(Number(s3File.imageOriginalHeight) || 800, 2000));
		sizes.add(width + "x" + height);
		sizes.add("800x400");

		projectIds.forEach(function(projectId) {
			sizes.forEach(function(size) {
				candidates.push(
					window.location.origin + "/file-proxy/signed-preview/" + projectId + "/" + node.id + "/" + size + "/"
				);
			});
		});

		return Array.from(new Set(candidates));
	}

	function sanitizeFileStem(value, fallback) {
		var stem = (value || "")
			.replace(/[\\/:*?"<>|]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return stem || fallback;
	}

	function getExtensionFromContentType(contentType) {
		if (!contentType) return "";
		var normalized = contentType.split(";")[0].trim().toLowerCase();
		var map = {
			"image/jpeg": ".jpg",
			"image/png": ".png",
			"image/gif": ".gif",
			"image/webp": ".webp",
			"image/svg+xml": ".svg",
			"image/avif": ".avif",
			"image/bmp": ".bmp"
		};
		return map[normalized] || "";
	}

	function getExtensionFromSource(src) {
		if (!src) return "";
		var dataMatch = src.match(/^data:image\/([a-z0-9.+-]+);/i);
		if (dataMatch) {
			var dataType = dataMatch[1].toLowerCase();
			if (dataType === "jpeg") return ".jpg";
			if (dataType === "svg+xml") return ".svg";
			return "." + dataType.replace(/[^a-z0-9]+/g, "");
		}

		var cleanSrc = src.split("?")[0].split("#")[0];
		var extMatch = cleanSrc.match(/\.([a-z0-9]{2,5})$/i);
		return extMatch ? "." + extMatch[1].toLowerCase() : "";
	}

	function createPageAssetContext(pageName) {
		return {
			pageStem: sanitizeFileStem(pageName, "Imported Page"),
			assetCount: 0,
			assetsBySource: new Map(),
			assets: []
		};
	}

	function registerImageAsset(src, alt, assetContext) {
		if (!src) return "";
		if (!assetContext) return src;

		var normalizedSrc = normalizeImageSource(src);
		var existing = assetContext.assetsBySource.get(normalizedSrc);
		if (existing) return existing.placeholder;

		assetContext.assetCount += 1;
		var altStem = sanitizeFileStem(alt, "image");
		var placeholder = IMAGE_PLACEHOLDER_PREFIX + assetContext.assetCount + "__";
		var asset = {
			source: normalizedSrc,
			placeholder: placeholder,
			alt: altStem,
			baseName: assetContext.pageStem + " - " + altStem + " " + assetContext.assetCount
		};

		assetContext.assetsBySource.set(normalizedSrc, asset);
		assetContext.assets.push(asset);
		return placeholder;
	}

	function registerImageAssetCandidates(candidates, alt, assetContext) {
		var normalizedCandidates = (candidates || []).map(normalizeImageSource).filter(Boolean);
		if (!normalizedCandidates.length) return "";
		if (!assetContext) return normalizedCandidates[0];

		var dedupedCandidates = Array.from(new Set(normalizedCandidates));
		var groupKey = dedupedCandidates.join("\n");
		var existing = assetContext.assetsBySource.get(groupKey);
		if (existing) return existing.placeholder;

		assetContext.assetCount += 1;
		var altStem = sanitizeFileStem(alt, "image");
		var placeholder = IMAGE_PLACEHOLDER_PREFIX + assetContext.assetCount + "__";
		var asset = {
			source: dedupedCandidates[0],
			sourceCandidates: dedupedCandidates,
			placeholder: placeholder,
			alt: altStem,
			baseName: assetContext.pageStem + " - " + altStem + " " + assetContext.assetCount
		};

		assetContext.assetsBySource.set(groupKey, asset);
		assetContext.assets.push(asset);
		return placeholder;
	}

	function extractImageSourceFromHtml(html) {
		var matches = extractImageSourcesFromText(html);
		return matches.length ? matches[0] : "";
	}

	function getElementImageSource(node) {
		if (!node || node.nodeType !== Node.ELEMENT_NODE) return "";

		var directAttributes = [
			"src",
			"data-src",
			"data-url",
			"data-original",
			"data-original-src",
			"data-image",
			"href"
		];

		for (var i = 0; i < directAttributes.length; i += 1) {
			var value = node.getAttribute(directAttributes[i]);
			if (value && /^(data:image\/|blob:|https?:\/\/|\/)/i.test(value)) {
				return normalizeImageSource(value);
			}
		}

		var styleSource = extractUrlFromCssValue(node.getAttribute("style") || "");
		if (styleSource) return normalizeImageSource(styleSource);

		if (window.getComputedStyle) {
			var computedStyleSource = extractUrlFromCssValue(window.getComputedStyle(node).backgroundImage);
			if (computedStyleSource) return normalizeImageSource(computedStyleSource);
		}

		var nestedImage = node.querySelector("img, [style*='background-image'], [data-src], [data-url], [data-image], [data-original-src]");
		if (nestedImage && nestedImage !== node) {
			return getElementImageSource(nestedImage);
		}

		return "";
	}

	function buildImageMarkdown(node, assetContext) {
		var src = getElementImageSource(node);
		if (!src) return "";

		var alt = escapeMarkdownImageText(
			node.getAttribute("alt") ||
			node.getAttribute("title") ||
			node.textContent ||
			"image"
		).trim() || "image";

		var target = registerImageAsset(src, alt, assetContext);
		return "![" + alt + "](" + target + ")";
	}

	function buildImageMarkdownFromSource(src, alt, assetContext) {
		if (!src) return "";
		var safeAlt = escapeMarkdownImageText(alt || "image").trim() || "image";
		var target = registerImageAsset(src, safeAlt, assetContext);
		return "![" + safeAlt + "](" + target + ")";
	}

	function buildImageMarkdownFromMeta(imageMeta, assetContext) {
		if (!imageMeta || !imageMeta.sourceCandidates || !imageMeta.sourceCandidates.length) return "";

		var alt = imageMeta.fileName || "image";
		var target = registerImageAssetCandidates(imageMeta.sourceCandidates, alt, assetContext);
		return target ? "![" + escapeMarkdownImageText(alt) + "](" + target + ")" : "";
	}

	function htmlToMarkdown(html, assetContext, fallbackImageSources, imageMeta) {
		if (!html) {
			if (fallbackImageSources && fallbackImageSources.length) {
				var fallbackTarget = registerImageAssetCandidates(fallbackImageSources, "image", assetContext);
				return fallbackTarget ? "![image](" + fallbackTarget + ")" : "";
			}

			if (imageMeta) {
				return buildImageMarkdownFromMeta(imageMeta, assetContext);
			}

			return "";
		}

		var container = document.createElement("div");
		container.innerHTML = markInternalLinks(html);
		var fallbackInlineImageSource = extractImageSourceFromHtml(container.innerHTML) || extractImageSourceFromHtml(html);

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
			if (tag === "IMG") {
				var imageMarkdown = buildImageMarkdown(node, assetContext);
				return imageMarkdown || "[Image]";
			}
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
				if (!blockText) {
					var blockImageMarkdown = buildImageMarkdown(node, assetContext);
					if (blockImageMarkdown) return blockImageMarkdown + "\n\n";
				}
				return blockText ? blockText + "\n\n" : "";
			}

			var imageMarkdownFallback = buildImageMarkdown(node, assetContext);
			if (imageMarkdownFallback) return imageMarkdownFallback;

			return renderChildren(node, context);
		}

		var markdown = renderChildren(container, { preserveNewlines: true });
		markdown = markdown
			.replace(/\r\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]+\n/g, "\n")
			.trim();

		if (!markdown && fallbackInlineImageSource) {
			var fallbackTarget = registerImageAsset(fallbackInlineImageSource, "image", assetContext);
			return "![image](" + fallbackTarget + ")";
		}

		if (!markdown && fallbackImageSources && fallbackImageSources.length) {
			var target = registerImageAssetCandidates(fallbackImageSources, "image", assetContext);
			return target ? "![image](" + target + ")" : "";
		}

		if (!markdown && imageMeta) {
			var markdownFromMeta = buildImageMarkdownFromMeta(imageMeta, assetContext);
			if (markdownFromMeta) return markdownFromMeta;
		}

		return markdown;
	}

	function normalizeTree(node, assetContext) {
		var normalized = {
			id: node.id,
			nameMarkdown: htmlToMarkdown(node.name, assetContext, node.imageSources, node.imageMeta),
			noteMarkdown: htmlToMarkdown(node.note, assetContext, node.imageSources, node.imageMeta),
			completed: node.completed,
			mirrorRootId: node.mirrorRootId,
			mirrorRootName: node.mirrorRootName,
			imageSources: node.imageSources,
			imageMeta: node.imageMeta,
			children: ensureChildren(node).map(function(child) {
				return normalizeTree(child, assetContext);
			})
		};

		return normalized;
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
			.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
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

	function replaceAssetPlaceholders(content, assetFiles) {
		var nextContent = content;
		assetFiles.forEach(function(assetFile) {
			nextContent = nextContent.split(assetFile.placeholder).join(assetFile.fileName);
		});
		return nextContent;
	}

	async function resolveAssetResponse(response) {
		var contentType = (response.headers.get("content-type") || "").toLowerCase();
		if (contentType.indexOf("application/json") === -1) {
			return response;
		}

		var payload = await response.json();
		if (!payload || typeof payload.url !== "string" || !payload.url) {
			throw new Error("JSON asset response missing url");
		}

		var redirectedResponse = await fetch(payload.url);
		if (!redirectedResponse.ok) {
			throw new Error("HTTP " + redirectedResponse.status + " for redirected asset");
		}

		return redirectedResponse;
	}

	async function fetchAssetFile(asset) {
		var sources = asset.sourceCandidates && asset.sourceCandidates.length ? asset.sourceCandidates : [asset.source];
		var lastError = null;

		for (var i = 0; i < sources.length; i += 1) {
			try {
				var response = await fetch(sources[i]);
				if (!response.ok) {
					throw new Error("HTTP " + response.status);
				}

				response = await resolveAssetResponse(response);
				var blob = await response.blob();
				var extension = getExtensionFromContentType(blob.type) || getExtensionFromSource(response.url || sources[i]) || getExtensionFromSource(sources[i]) || ".img";
				return {
					placeholder: asset.placeholder,
					fileName: asset.baseName + extension,
					content: blob
				};
			} catch (error) {
				lastError = error;
			}
		}

		console.warn("Unable to download image asset:", sources, lastError);
		return null;
	}

	async function finalizePage(rootNode, index) {
		var provisionalPageName = sanitizePageName(rootNode.name || "", "Imported Page " + index);
		var assetContext = createPageAssetContext(provisionalPageName);
		var normalizedRoot = normalizeTree(rootNode, assetContext);
		var pageFile = renderPage(normalizedRoot, index);
		var assetFiles = (await Promise.all(assetContext.assets.map(fetchAssetFile))).filter(Boolean);
		pageFile.content = replaceAssetPlaceholders(pageFile.content, assetFiles);
		return {
			page: pageFile,
			assets: assetFiles
		};
	}

	function downloadFile(file) {
		var blob = file.content instanceof Blob
			? file.content
			: new Blob([file.content], { type: "text/markdown;charset=utf-8" });
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
		return node;
	});
	var bundles = await Promise.all(normalizedRoots.map(finalizePage));
	var files = [];
	bundles.forEach(function(bundle) {
		files.push(bundle.page);
		bundle.assets.forEach(function(asset) {
			files.push(asset);
		});
	});

	files.forEach(downloadFile);

	console.log("Exported Logseq pages:", bundles.map(function(bundle) {
		return bundle.page.fileName;
	}));
	console.log("Exported image assets:", files.filter(function(file) {
		return file !== null && file !== undefined && file.content instanceof Blob;
	}).map(function(file) {
		return file.fileName;
	}));
})();
