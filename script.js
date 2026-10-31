// 全局状态
let bubbles = [];
let connections = [];
let selectedBubble = null;
let hoveredBubble = null;
let bubbleIdCounter = 0;
const bubbleById = new Map();          // id → 气泡
const elementToBubble = new WeakMap(); // DOM 元素 → 气泡
const multiSelection = new Set();      // 框选中的气泡
let drag = null;                       // 正在进行的拖动
let marquee = null;                    // 正在进行的框选
let suppressClickUntil = 0;            // 拖动/框选结束后短暂屏蔽 click
const DRAG_THRESHOLD = 5;              // 移动超过这么多像素才算拖动

// DOM 元素
const wordInput = document.getElementById('wordInput');
const relatedPopup = document.getElementById('relatedPopup');
const bubbleContainer = document.getElementById('bubbleContainer');
const canvas = document.getElementById('connectionCanvas');
const ctx = canvas.getContext('2d');

// 初始化画布大小
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawConnections();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// 按回车添加气泡
wordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && wordInput.value.trim()) {
        createBubble(wordInput.value.trim());
        wordInput.value = '';
        saveState();
    }
});

// 随机生成气泡位置，尽量避开页面中间的输入区
function randomPosition() {
    const inputSection = document.querySelector('.input-section');
    const box = inputSection.getBoundingClientRect();
    const pad = 40;
    let x, y;
    for (let i = 0; i < 30; i++) {
        x = Math.random() * Math.max(window.innerWidth - 200, 1) + 50;
        y = Math.random() * Math.max(window.innerHeight - 120, 1) + 30;
        const overlaps =
            x + 150 > box.left - pad && x < box.right + pad &&
            y + 60 > box.top - pad && y < box.bottom + pad;
        if (!overlaps) break;
    }
    return { x, y };
}

// 创建气泡（options 用于从存档恢复：id、x、y、parentId、expanded）
function createBubble(word, options = {}) {
    const pos = (options.x !== undefined && options.y !== undefined)
        ? { x: options.x, y: options.y }
        : randomPosition();
    const id = options.id !== undefined ? options.id : bubbleIdCounter;
    bubbleIdCounter = Math.max(bubbleIdCounter, id + 1);

    const bubble = {
        id: id,
        word: word,
        x: pos.x,
        y: pos.y,
        parentId: options.parentId ?? null, // 归类到哪个气泡下
        expanded: options.expanded === true, // 分组是否展开
        element: null,
        badge: null
    };

    // 创建 DOM 元素：单词 + 分组数量角标
    const bubbleElement = document.createElement('div');
    bubbleElement.className = 'bubble pulse';
    bubbleElement.style.left = bubble.x + 'px';
    bubbleElement.style.top = bubble.y + 'px';

    const wordSpan = document.createElement('span');
    wordSpan.className = 'bubble-word';
    wordSpan.textContent = word;

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'group-badge';
    badge.hidden = true;
    // 角标只负责展开/收起，不触发拖动、选择或删除
    badge.addEventListener('pointerdown', (e) => e.stopPropagation());
    badge.addEventListener('dblclick', (e) => e.stopPropagation());
    badge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExpand(bubble);
    });

    bubbleElement.append(wordSpan, badge);
    bubble.badge = badge;

    // 按下鼠标：可能是拖动的开始
    bubbleElement.addEventListener('pointerdown', (e) => startBubbleDrag(e, bubble));

    // 移除 pulse 动画类
    setTimeout(() => {
        bubbleElement.classList.remove('pulse');
    }, 500);

    // 单击选择气泡或创建连接
    bubbleElement.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Date.now() < suppressClickUntil) return; // 刚拖动完，不算点击
        handleBubbleClick(bubble);
    });

    // 双击删除气泡
    bubbleElement.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        deleteBubble(bubble);
    });

    // 鼠标悬停时的额外动画效果
    bubbleElement.addEventListener('mouseenter', () => {
        bubbleElement.style.animationPlayState = 'paused';
        // 拖动或框选过程中不弹出关联词面板
        if ((drag && drag.started) || (marquee && marquee.active)) return;
        showRelated(bubble);
    });

    bubbleElement.addEventListener('mouseleave', () => {
        bubbleElement.style.animationPlayState = 'running';
        hideRelated();
    });

    bubble.element = bubbleElement;
    bubbles.push(bubble);
    bubbleById.set(bubble.id, bubble);
    elementToBubble.set(bubbleElement, bubble);
    bubbleContainer.appendChild(bubbleElement);
    return bubble;
}

// 处理气泡点击
function handleBubbleClick(bubble) {
    if (!selectedBubble) {
        // 选择第一个气泡
        selectedBubble = bubble;
        bubble.element.classList.add('selected');
    } else if (selectedBubble.id === bubble.id) {
        // 点击同一个气泡，取消选择
        bubble.element.classList.remove('selected');
        selectedBubble = null;
    } else {
        // 选择第二个气泡，创建连接
        createConnection(selectedBubble, bubble);
        selectedBubble.element.classList.remove('selected');
        selectedBubble = null;
    }
}

// 创建连接
function createConnection(bubble1, bubble2) {
    // 检查连接是否已存在
    const exists = connections.some(conn =>
        (conn.bubble1.id === bubble1.id && conn.bubble2.id === bubble2.id) ||
        (conn.bubble1.id === bubble2.id && conn.bubble2.id === bubble1.id)
    );

    if (!exists) {
        connections.push({ bubble1, bubble2 });
        drawConnections();
        saveState();
        // 如果正悬停在其中一个气泡上，立即刷新关联词面板
        if (hoveredBubble && (hoveredBubble.id === bubble1.id || hoveredBubble.id === bubble2.id)) {
            showRelated(hoveredBubble);
        }
    }
}

// 获取与某个气泡相关联的所有气泡
function getRelatedBubbles(bubble) {
    return connections
        .filter(conn => conn.bubble1.id === bubble.id || conn.bubble2.id === bubble.id)
        .map(conn => (conn.bubble1.id === bubble.id ? conn.bubble2 : conn.bubble1));
}

// 悬停时显示关联词和分组成员
function showRelated(bubble) {
    hoveredBubble = bubble;
    const related = getRelatedBubbles(bubble);
    const members = getChildren(bubble);

    // 高亮关联气泡（被收起的用所在分组代替），淡化无关气泡；本组成员不淡化
    const highlightIds = new Set(
        related.map(visibleAnchor).filter(b => b && b !== bubble).map(b => b.id)
    );
    bubbles.forEach(b => {
        const isRelated = highlightIds.has(b.id);
        b.element.classList.toggle('related', isRelated);
        b.element.classList.toggle('dimmed',
            b !== bubble && !isRelated && b.parentId !== bubble.id);
    });

    // 构建浮动面板内容（用 textContent 防止注入）
    relatedPopup.replaceChildren();
    const title = document.createElement('div');
    title.className = 'popup-title';
    title.textContent = `「${bubble.word}」的关联词`;
    relatedPopup.appendChild(title);

    if (related.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'popup-empty';
        empty.textContent = '暂无关联，点击两个气泡来建立连接';
        relatedPopup.appendChild(empty);
    } else {
        relatedPopup.appendChild(buildChipList(related, 'related-chip'));
    }

    if (members.length > 0) {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'popup-title popup-subtitle';
        groupTitle.textContent = `分组内（${members.length}）`;
        relatedPopup.append(groupTitle, buildChipList(members, 'related-chip group-chip'));
    }

    positionPopup(bubble);
    relatedPopup.classList.add('visible');
    relatedPopup.setAttribute('aria-hidden', 'false');
}

// 生成一排会漂浮的单词小标签
function buildChipList(list, className) {
    const wrap = document.createElement('div');
    wrap.className = 'popup-words';
    list.forEach((b, i) => {
        const chip = document.createElement('span');
        chip.className = className;
        chip.textContent = b.word;
        // 错开弹出和漂浮的节奏，让每个词浮动得不一样
        chip.style.animationDelay = `${i * 0.06}s, ${i * 0.3}s`;
        wrap.appendChild(chip);
    });
    return wrap;
}

// 隐藏关联词
function hideRelated() {
    hoveredBubble = null;
    relatedPopup.classList.remove('visible');
    relatedPopup.setAttribute('aria-hidden', 'true');
    bubbles.forEach(b => b.element.classList.remove('related', 'dimmed'));
}

// 把面板放在气泡上方，空间不够则放到下方，并限制在窗口内
function positionPopup(bubble) {
    const rect = bubble.element.getBoundingClientRect();
    // 用 offsetWidth/offsetHeight 取真实尺寸，避免隐藏状态下 scale(0.95) 导致计算偏差
    const popupRect = {
        width: relatedPopup.offsetWidth,
        height: relatedPopup.offsetHeight
    };
    const margin = 12;

    let left = rect.left + rect.width / 2 - popupRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popupRect.width - margin));

    let top = rect.top - popupRect.height - margin;
    if (top < margin) {
        top = rect.bottom + margin;
    }

    relatedPopup.style.left = left + 'px';
    relatedPopup.style.top = top + 'px';
}

// 删除气泡（分组里的成员不会被删，而是交还给上一级分组或放回画布）
function deleteBubble(bubble) {
    // 删除相关连接
    connections = connections.filter(conn =>
        conn.bubble1.id !== bubble.id && conn.bubble2.id !== bubble.id
    );

    const members = getChildren(bubble);
    const cx = bubble.x + bubble.element.offsetWidth / 2;
    const cy = bubble.y + bubble.element.offsetHeight / 2;
    members.forEach(m => { m.parentId = bubble.parentId; });

    // 删除气泡
    bubbles = bubbles.filter(b => b.id !== bubble.id);
    bubbleById.delete(bubble.id);
    setMultiSelected(bubble, false);
    bubble.element.remove();

    // 如果删除的是选中的气泡，清除选择
    if (selectedBubble === bubble) {
        selectedBubble = null;
    }

    // 删除后清除悬停状态
    hideRelated();
    refreshGroups();

    // 成员交给了上一级分组时，重新排列上一级分组
    const parent = bubbleById.get(bubble.parentId);
    if (parent) layoutChildren(parent);

    // 放回画布的成员围绕原来的位置散开
    const released = members.filter(m => m.parentId === null);
    released.forEach((m, i) => {
        const angle = (i / released.length) * Math.PI * 2;
        setBubblePosition(m,
            cx + Math.cos(angle) * 110 - m.element.offsetWidth / 2,
            cy + Math.sin(angle) * 80 - m.element.offsetHeight / 2);
        layoutChildren(m);
    });

    drawConnections();
    saveState();
}

// 绘制所有连接
function drawConnections() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGroupLinks();

    connections.forEach(conn => {
        // 被收起的气泡用所在分组代替；两端落在同一个气泡上就不画
        const a = visibleAnchor(conn.bubble1);
        const b = visibleAnchor(conn.bubble2);
        if (!a || !b || a === b) return;
        const rect1 = a.element.getBoundingClientRect();
        const rect2 = b.element.getBoundingClientRect();

        const x1 = rect1.left + rect1.width / 2;
        const y1 = rect1.top + rect1.height / 2;
        const x2 = rect2.left + rect2.width / 2;
        const y2 = rect2.top + rect2.height / 2;

        // 悬停时：与悬停气泡相连的线加粗发光，其余线变淡
        const isActive = hoveredBubble && (a === hoveredBubble || b === hoveredBubble);
        const isFaded = hoveredBubble && !isActive;
        const alpha = isFaded ? 0.2 : 1;

        // 绘制渐变线条
        const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${0.8 * alpha})`);
        gradient.addColorStop(0.5, `rgba(255, 215, 0, ${(isActive ? 1 : 0.6) * alpha})`);
        gradient.addColorStop(1, `rgba(255, 255, 255, ${0.8 * alpha})`);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = isActive ? 5 : 3;
        ctx.lineCap = 'round';
        ctx.shadowBlur = isActive ? 20 : 10;
        ctx.shadowColor = `rgba(255, 215, 0, ${0.5 * alpha})`;
        ctx.stroke();
        ctx.shadowBlur = 0;
    });
}

// 展开的分组：用虚线把成员和分组气泡连起来
function drawGroupLinks() {
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    bubbles.forEach(child => {
        const parent = bubbleById.get(child.parentId);
        if (!parent || isHidden(child)) return;
        const r1 = parent.element.getBoundingClientRect();
        const r2 = child.element.getBoundingClientRect();
        ctx.beginPath();
        ctx.moveTo(r1.left + r1.width / 2, r1.top + r1.height / 2);
        ctx.lineTo(r2.left + r2.width / 2, r2.top + r2.height / 2);
        ctx.stroke();
    });
    ctx.restore();
}

// 取消连线选择和框选
function clearSelections() {
    clearMultiSelection();
    if (selectedBubble) {
        selectedBubble.element.classList.remove('selected');
        selectedBubble = null;
    }
}

// 点击空白处取消选择（刚拖动或框选完的那次点击不算）
document.addEventListener('click', () => {
    if (Date.now() < suppressClickUntil) return;
    clearSelections();
});

// Esc 取消选择
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSelections();
});

// ================= 分组 / 拖动 / 框选 =================

// 某个气泡的直接成员
function getChildren(bubble) {
    return bubbles.filter(b => b.parentId === bubble.id);
}

// a 是否是 b 的上级（父、祖父……）
function isAncestor(a, b) {
    let p = bubbleById.get(b.parentId);
    for (let guard = 0; p && guard <= bubbles.length; guard++) {
        if (p === a) return true;
        p = bubbleById.get(p.parentId);
    }
    return false;
}

// 任意一级上级分组处于收起状态时，气泡不显示
function isHidden(bubble) {
    let p = bubbleById.get(bubble.parentId);
    for (let guard = 0; p && guard <= bubbles.length; guard++) {
        if (!p.expanded) return true;
        p = bubbleById.get(p.parentId);
    }
    return false;
}

// 画面上代表这个气泡的可见气泡（被收起时就是外层分组）
function visibleAnchor(bubble) {
    let b = bubble;
    for (let guard = 0; b && isHidden(b) && guard <= bubbles.length; guard++) {
        b = bubbleById.get(b.parentId);
    }
    return b || null;
}

function centerOf(bubble) {
    return {
        x: bubble.x + bubble.element.offsetWidth / 2,
        y: bubble.y + bubble.element.offsetHeight / 2
    };
}

// 移动气泡（限制在窗口内）
function setBubblePosition(bubble, x, y) {
    const w = bubble.element.offsetWidth || 120;
    const h = bubble.element.offsetHeight || 50;
    bubble.x = Math.min(Math.max(x, 0), Math.max(window.innerWidth - w, 0));
    bubble.y = Math.min(Math.max(y, 0), Math.max(window.innerHeight - h, 0));
    bubble.element.style.left = bubble.x + 'px';
    bubble.element.style.top = bubble.y + 'px';
}

// 排列分组成员：展开时绕着分组气泡排成一圈，收起时全部收进分组气泡中心
function layoutChildren(parent) {
    const kids = getChildren(parent);
    if (kids.length === 0) return;
    const c = centerOf(parent);

    kids.forEach((k, i) => {
        const w = k.element.offsetWidth;
        const h = k.element.offsetHeight;
        if (parent.expanded && !isHidden(parent)) {
            const angle = (i / kids.length) * Math.PI * 2 - Math.PI / 2;
            const r = 90 + kids.length * 10;
            setBubblePosition(k, c.x + Math.cos(angle) * r * 1.4 - w / 2,
                c.y + Math.sin(angle) * r - h / 2);
        } else {
            setBubblePosition(k, c.x - w / 2, c.y - h / 2);
        }
        layoutChildren(k);
    });
}

// 刷新所有气泡的分组状态：是否隐藏、角标数字
function refreshGroups() {
    const counts = new Map();
    bubbles.forEach(b => {
        if (b.parentId !== null) counts.set(b.parentId, (counts.get(b.parentId) || 0) + 1);
    });

    bubbles.forEach(b => {
        const n = counts.get(b.id) || 0;
        if (n === 0) b.expanded = false;
        const hidden = isHidden(b);

        b.element.classList.toggle('in-group-hidden', hidden);
        b.element.classList.toggle('has-group', n > 0);
        b.element.classList.toggle('expanded', b.expanded);
        b.element.setAttribute('aria-hidden', hidden ? 'true' : 'false');

        b.badge.hidden = n === 0;
        b.badge.textContent = String(n);
        const label = `${b.expanded ? '收起' : '展开'}分组（${n} 个单词）`;
        b.badge.title = label;
        b.badge.setAttribute('aria-label', label);
        b.badge.tabIndex = hidden ? -1 : 0;

        // 被收起的气泡不能保持选中
        if (hidden) {
            setMultiSelected(b, false);
            if (selectedBubble === b) {
                b.element.classList.remove('selected');
                selectedBubble = null;
            }
        }
    });
}

// 展开 / 收起一个分组
function toggleExpand(bubble) {
    if (getChildren(bubble).length === 0) return;
    bubble.expanded = !bubble.expanded;
    refreshGroups();
    layoutChildren(bubble);
    if (hoveredBubble) showRelated(hoveredBubble);
    saveState();
}

// 把一批气泡归入目标气泡，并收进去
function groupInto(target, items) {
    const set = new Set(items);
    // 只移动最外层的气泡；它们自己的成员会跟着一起走
    const tops = items.filter(b =>
        b !== target && !isAncestor(b, target) &&
        !items.some(o => o !== b && set.has(o) && isAncestor(o, b))
    );
    if (tops.length === 0) return;

    const oldParents = new Set(tops.map(b => bubbleById.get(b.parentId)).filter(Boolean));
    tops.forEach(b => { b.parentId = target.id; });
    target.expanded = false;

    clearMultiSelection();
    refreshGroups();
    layoutChildren(target);
    oldParents.forEach(p => { if (p !== target) layoutChildren(p); });

    // 目标气泡弹一下，表示“吸收”了这些单词
    target.element.classList.remove('pulse');
    void target.element.offsetWidth;
    target.element.classList.add('pulse');
    setTimeout(() => target.element.classList.remove('pulse'), 500);

    saveState();
    showStatus(`已将 ${tops.length} 个单词归入「${target.word}」`);
}

// 把成员移出所在分组，放回画布
function ungroup(items) {
    const moved = items.filter(b => b.parentId !== null);
    if (moved.length === 0) return 0;
    const oldParents = new Set(moved.map(b => bubbleById.get(b.parentId)).filter(Boolean));
    moved.forEach(b => { b.parentId = null; });
    refreshGroups();
    oldParents.forEach(p => layoutChildren(p));
    return moved.length;
}

// 框选状态的增删
function setMultiSelected(bubble, on) {
    if (on) multiSelection.add(bubble);
    else multiSelection.delete(bubble);
    bubble.element.classList.toggle('multi-selected', on);
}

function clearMultiSelection() {
    multiSelection.forEach(b => b.element.classList.remove('multi-selected'));
    multiSelection.clear();
}

// 找到鼠标位置下第一个可放置的气泡（隐藏的、正在拖的不算）
function bubbleAtPoint(x, y, isExcluded) {
    for (const el of document.elementsFromPoint(x, y)) {
        const bubbleEl = el.closest('.bubble');
        if (!bubbleEl) continue;
        const b = elementToBubble.get(bubbleEl);
        if (b && !isHidden(b) && !isExcluded(b)) return b;
    }
    return null;
}

function setDropTarget(target) {
    if (drag.target === target) return;
    if (drag.target) drag.target.element.classList.remove('drop-target');
    drag.target = target;
    if (target) target.element.classList.add('drop-target');
}

// 在气泡上按下鼠标：记录起点，移动超过阈值才真正开始拖动
function startBubbleDrag(e, bubble) {
    if (e.button !== 0 || drag || marquee) return;
    // 按住的是框选中的气泡，就整批一起拖
    const picked = multiSelection.has(bubble) ? [...multiSelection] : [bubble];
    // 上级也被选中的成员会跟着上级走，不单独移动
    const items = picked.filter(b => !picked.some(o => o !== b && isAncestor(o, b)));
    drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        items,
        origins: items.map(b => ({ x: b.x, y: b.y })),
        started: false,
        target: null
    };
}

// 拖动过程中：整批移动，并找出鼠标下方的目标气泡
function updateDrag(e) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.started = true;
        hideRelated();
        drag.items.forEach(b => b.element.classList.add('dragging'));
    }

    drag.items.forEach((b, i) => {
        setBubblePosition(b, drag.origins[i].x + dx, drag.origins[i].y + dy);
        layoutChildren(b);
    });

    // 不能放进自己或自己的成员里
    const target = bubbleAtPoint(e.clientX, e.clientY, b =>
        drag.items.some(item => item === b || isAncestor(item, b)));
    setDropTarget(target);
}

// 松开鼠标：落在气泡上就归类；落在空白处则移出原分组
function endDrag(cancelled) {
    const d = drag;
    drag = null;
    if (!d.started) return; // 只是普通点击

    d.items.forEach(b => b.element.classList.remove('dragging'));
    if (d.target) d.target.element.classList.remove('drop-target');
    suppressClickUntil = Date.now() + 300;

    if (cancelled) {
        // 取消：回到原位
        d.items.forEach((b, i) => {
            setBubblePosition(b, d.origins[i].x, d.origins[i].y);
            layoutChildren(b);
        });
        return;
    }

    if (d.target) {
        groupInto(d.target, d.items);
        return;
    }

    const n = ungroup(d.items);
    saveState();
    if (n > 0) showStatus(`已将 ${n} 个单词移出分组`);
}

// 框选矩形
const marqueeEl = document.createElement('div');
marqueeEl.id = 'marquee';
marqueeEl.hidden = true;
document.body.appendChild(marqueeEl);

// 在空白处按下左键开始框选（按住 Shift / ⌘ / Ctrl 可追加选择）
document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || marquee) return;
    if (e.target.closest('.bubble, .input-section, #relatedPopup')) return;
    e.preventDefault(); // 避免选中页面文字，也让输入框保持焦点
    marquee = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        base: (e.shiftKey || e.metaKey || e.ctrlKey) ? new Set(multiSelection) : new Set()
    };
});

function updateMarquee(e) {
    const left = Math.min(marquee.startX, e.clientX);
    const top = Math.min(marquee.startY, e.clientY);
    const right = Math.max(marquee.startX, e.clientX);
    const bottom = Math.max(marquee.startY, e.clientY);

    if (!marquee.active) {
        if (Math.hypot(right - left, bottom - top) < DRAG_THRESHOLD) return;
        marquee.active = true;
        hideRelated();
        marqueeEl.hidden = false;
        document.body.classList.add('is-marqueeing');
    }

    marqueeEl.style.left = left + 'px';
    marqueeEl.style.top = top + 'px';
    marqueeEl.style.width = (right - left) + 'px';
    marqueeEl.style.height = (bottom - top) + 'px';

    // 和矩形有交集的可见气泡都算选中
    bubbles.forEach(b => {
        let hit = false;
        if (!isHidden(b)) {
            const r = b.element.getBoundingClientRect();
            hit = r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom;
        }
        setMultiSelected(b, hit || marquee.base.has(b));
    });
}

function endMarquee() {
    if (marquee.active) {
        suppressClickUntil = Date.now() + 300; // 别让这次松开被当成“点击空白取消选择”
        marqueeEl.hidden = true;
        document.body.classList.remove('is-marqueeing');
        if (multiSelection.size > 0) {
            showStatus(`已选中 ${multiSelection.size} 个，拖到某个气泡上即可归类`);
        }
    }
    marquee = null;
}

window.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.pointerId) updateDrag(e);
    else if (marquee && e.pointerId === marquee.pointerId) updateMarquee(e);
});

window.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(false);
    else if (marquee && e.pointerId === marquee.pointerId) endMarquee();
});

window.addEventListener('pointercancel', () => {
    if (drag) endDrag(true);
    if (marquee) endMarquee();
});

// 切走窗口时中止拖动，避免气泡“粘”在鼠标上
window.addEventListener('blur', () => {
    if (drag) endDrag(true);
    if (marquee) endMarquee();
});

// 拖动中按 Esc 取消拖动
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) endDrag(true);
});

// 定期重绘连接（因为气泡在浮动）
setInterval(drawConnections, 50);

// ================= 保存 / 恢复 =================
const STORAGE_KEY = 'wordConnection.v1';
const saveStatus = document.getElementById('saveStatus');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');
let statusTimer = null;

// 在工具栏显示一条短暂的状态提示
function showStatus(message) {
    saveStatus.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        saveStatus.textContent = '';
    }, 2500);
}

// 把当前气泡和连接转成可序列化的数据（连接只存 id）
function serializeState() {
    return {
        version: 1,
        savedAt: new Date().toISOString(),
        bubbles: bubbles.map(b => ({
            id: b.id, word: b.word, x: b.x, y: b.y,
            parentId: b.parentId, expanded: b.expanded
        })),
        connections: connections.map(c => [c.bubble1.id, c.bubble2.id])
    };
}

// 自动保存到浏览器本地存储
function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
        showStatus('已自动保存');
    } catch (err) {
        console.error('保存失败', err);
        showStatus('保存失败：浏览器存储不可用');
    }
}

// 清空画布上的所有气泡和连接
function clearAll() {
    hideRelated();
    clearMultiSelection();
    selectedBubble = null;
    bubbles.forEach(b => b.element.remove());
    bubbles = [];
    connections = [];
    bubbleById.clear();
    bubbleIdCounter = 0;
    drawConnections();
}

// 校验并应用一份存档数据，格式不对时抛出错误
function applyState(data) {
    if (!data || !Array.isArray(data.bubbles) || !Array.isArray(data.connections)) {
        throw new Error('文件格式不正确');
    }

    // 过滤掉无效条目，并跳过重复的 id
    const seenIds = new Set();
    const validBubbles = data.bubbles.filter(b => {
        const ok = b && Number.isInteger(b.id) && b.id >= 0 && !seenIds.has(b.id) &&
            typeof b.word === 'string' && b.word.trim() &&
            Number.isFinite(b.x) && Number.isFinite(b.y);
        if (ok) seenIds.add(b.id);
        return ok;
    });

    clearAll();

    validBubbles.forEach(b => {
        // 把位置限制在当前窗口内，避免换了屏幕尺寸后气泡跑到外面
        const x = Math.min(Math.max(b.x, 0), Math.max(window.innerWidth - 150, 0));
        const y = Math.min(Math.max(b.y, 0), Math.max(window.innerHeight - 60, 0));
        createBubble(b.word.trim(), { id: b.id, x, y, expanded: b.expanded === true });
    });

    // 恢复分组关系：上级必须存在，且不能形成循环
    validBubbles.forEach(b => {
        if (!Number.isInteger(b.parentId) || b.parentId === b.id) return;
        const child = bubbleById.get(b.id);
        const parent = bubbleById.get(b.parentId);
        if (!child || !parent || isAncestor(child, parent)) return;
        child.parentId = parent.id;
    });
    refreshGroups();
    bubbles.filter(b => b.parentId === null).forEach(layoutChildren);

    const byId = new Map(bubbles.map(b => [b.id, b]));
    data.connections.forEach(pair => {
        if (!Array.isArray(pair) || pair.length !== 2) return;
        const a = byId.get(pair[0]);
        const b = byId.get(pair[1]);
        if (a && b && a !== b) {
            const exists = connections.some(c =>
                (c.bubble1 === a && c.bubble2 === b) || (c.bubble1 === b && c.bubble2 === a)
            );
            if (!exists) connections.push({ bubble1: a, bubble2: b });
        }
    });

    drawConnections();
}

// 页面加载时恢复上次的内容；没有存档则放几个示例气泡
function loadState() {
    let raw = null;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
        console.error('读取存档失败', err);
    }

    if (raw) {
        try {
            applyState(JSON.parse(raw));
            showStatus(`已恢复 ${bubbles.length} 个单词、${connections.length} 个连接`);
            return;
        } catch (err) {
            console.error('存档损坏，已忽略', err);
        }
    }

    ['Hello', 'World', 'Connection'].forEach(word => createBubble(word));
    saveState();
}

// 导出为 JSON 文件
exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const json = JSON.stringify(serializeState(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `word-connections-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 稍后再释放，避免部分浏览器在下载开始前就取消
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus('已导出');
});

// 从 JSON 文件导入（会替换当前内容）
importBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    importInput.click();
});

importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = ''; // 允许重复导入同一个文件
    if (!file) return;

    if (bubbles.length > 0 && !confirm('导入会替换当前所有单词和连接，确定继续吗？')) {
        return;
    }

    try {
        const data = JSON.parse(await file.text());
        applyState(data);
        saveState();
        showStatus(`已导入 ${bubbles.length} 个单词、${connections.length} 个连接`);
    } catch (err) {
        console.error('导入失败', err);
        showStatus('导入失败：' + err.message);
    }
});

loadState();
