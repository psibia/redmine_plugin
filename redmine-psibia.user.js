// ==UserScript==
// @name         Redmine from psibia
// @namespace    http://tampermonkey.net/
// @version      1.3.1
// @description  Redmine plus (Loader)
// @author       psibia.p
// @match        https://pr.isands.ru/*
// @updateURL    https://raw.githubusercontent.com/psibia/redmine_plugin/main/redmine-psibia.user.js
// @downloadURL  https://raw.githubusercontent.com/psibia/redmine_plugin/main/redmine-psibia.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // =================================================================================
    // ЧАСТЬ 1: UI, МОДАЛЬНОЕ ОКНО И ЛОГИКА
    // =================================================================================

    const deadlineRegex = /(Deadline:|до)\s*(\d{2})\.(\d{2})\.(\d{4})/i; // регулярка для поиска дедлайна или срока завершения в карточках на доске, надо протестить, но вроде формат всегда такой
    const PREVIEW_WIDTH = 1200; // ширина айфрейма, можно менять под свое разрешение экрана, здесь я сделал под фулл хд

    // =================================================================================
    // ЕДИНАЯ КОНФИГУРАЦИЯ ПРИОРИТЕТОВ (Цвет, Вес, Название)
    // Порядок в этом массиве = порядок в контекстном меню ПКМ
    // =================================================================================
    const PRIORITIES_CONFIG = [
        { id: 'rdb-priority-6', label: 'Критический', color: '#0f172a', weight: 5 }, // Черный
        { id: 'rdb-priority-high', label: 'Высокий', color: '#e11d48', weight: 4 }, // Красный
        { id: 'rdb-priority-medium', label: 'Средний', color: '#f97316', weight: 3 }, // Оранжевый
        { id: 'rdb-priority-normal', label: 'Нормальный', color: '#10b940', weight: 2 }, // Зеленый
        { id: 'rdb-priority-low', label: 'Низкий', color: '#94a3b8', weight: 1 } // Серый
    ];

    let activeIssueId = null; // храним ID открытой задачи, это нужно для исправления бага анимации. Когда мы сворачиваем карточку, то мы ищем откуда она была развернута. Но если у нас включен рефрешер, то страница перерисовывается и даже если карточка есть на доске, текущий код не видит элемент и сворачивает iframe вникуда. Эта переменная нужна, чтобы мы привязывались к номеру задачи для этих целей
    // контейнер для кнопок в iframe, можно наполнять в методе initUI ниже через appendChild. Последовательность слева направо, просто поочередно добавляем новые кнопки
    let overlay, modal, buttonContainer;
    let activeSourceElement = null;
    let pulseTimer = null; // Таймер для пульсации карточки при закрытии айфрейма
    let cleanupTimer = null; // Таймер для очистки классов (чтобы сбрасывать состояние выбранной карточки, когда мы открываем новую в iframe, иначе они все дергаются)
    let isModalLocked = false; //блокирловка закрытия айфрейма чтобы при создании задачи случайно не закрыть его кликом по области. Закрывать будем только нажатием на крестик, в отличие от задач. Можно накатить условие и на обычный iframe в задачах, если будет бесить, что закрывается по клику вне iframe
    let updateStars; //переменная для функции добавления задачи в избранное
    let activeFilters = {
        users: [],
        projects: [],
        trackers: [],
        statuses: [],
        priorities: [],
        deadlines: [],
        onlyFavorites: false
    };

    // Сохраняем состояние ввода, чтобы курсор не пропадал при AJAX обновлениях Redmine
    let addonSearchState = {
        value: '',
        focused: false
    };

    window.removeActiveSearchTag = function(type, val) {
        if (type === 'users') activeFilters.users = activeFilters.users.filter(x => x !== val);
        else if (type === 'projects') activeFilters.projects = activeFilters.projects.filter(x => x !== val);
        else if (type === 'trackers') activeFilters.trackers = activeFilters.trackers.filter(x => x !== val);
        else if (type === 'statuses') activeFilters.statuses = activeFilters.statuses.filter(x => x !== val);
        else if (type === 'priorities') activeFilters.priorities = activeFilters.priorities.filter(x => x !== val);
        else if (type === 'deadlines') activeFilters.deadlines = activeFilters.deadlines.filter(x => x !== val);
        else if (type === 'fav') activeFilters.onlyFavorites = false;

        const input = document.querySelector('.addon-search-input');
        applySearchFilter(input ? input.value : '');

        if (window.currentDropdownView && typeof window.renderFiltersDropdownView === 'function') {
            const dropdown = document.getElementById('addon-filters-dropdown');
            if (dropdown && dropdown.style.display === 'flex') {
                window.renderFiltersDropdownView(window.currentDropdownView);
            }
        }
    };

    window.isAddonFullscreen = false; //сразу тут пишу, тк. связано с верхнем летом
    window.toggleAddonFullscreen = function() {
        window.isAddonFullscreen = !window.isAddonFullscreen;

        const topMenu = document.getElementById('top-menu');
        const header = document.getElementById('header');

        //скрываем или показываем блоки
        if (topMenu) topMenu.style.display = window.isAddonFullscreen ? 'none' : '';
        if (header) header.style.display = window.isAddonFullscreen ? 'none' : '';

        //тупо меняем цвет кнопке
        const btnLabel = document.querySelector('#addon-custom-fullscreen-btn label');
        if (btnLabel) {
            btnLabel.textContent = window.isAddonFullscreen ? 'Обычный экран' : 'Полный экран';
        }
    };

    // здесь основные стили (в основном вырезаю лишнее (панель справа, область редмайна не относящаяся к задаче, отстыупы и т.д.), чтобы отображалась только инфа, относящаяся к конкретной карточке задачи)
    function injectMainPageCSS() {
        const styleId = 'addon-kanban-fix';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .rdb-issue:hover { z-index: 1000 !important; position: relative !important; }
            .rdb-issue, .rdb-card { overflow: visible !important; }
            .rdb-menu-active .rdb-container, .rdb-container { z-index: 2000 !important; }
            .rdb-card-header { overflow: visible !important; z-index: auto !important; }

            /* ЛОАДЕР */
            .addon-loader {
                border: 4px solid #f3f3f3; border-top: 4px solid #3b82f6; border-radius: 50%;
                width: 40px; height: 40px; animation: addon-spin 1s linear infinite;
                position: absolute; top: 50%; left: 50%; margin-top: -20px; margin-left: -20px; z-index: 10002;
            }
            @keyframes addon-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

            /* АНИМАЦИЯ ПУЛЬСАЦИИ */
            @keyframes card-land-pulse {
                0% { transform: scale(1); box-shadow: 0 0 0 rgba(59, 130, 246, 0); }
                40% { transform: scale(1.03); box-shadow: 0 0 15px rgba(59, 130, 246, 0.3); z-index: 9999; position: relative; }
                100% { transform: scale(1); box-shadow: 0 0 0 rgba(59, 130, 246, 0); z-index: auto; }
            }
            .rdb-highlight-pulse {
                animation: card-land-pulse 0.5s ease-out forwards;
            }
        `;
        document.head.appendChild(style);
    }




   function injectNewCardCSS() {
        if (document.getElementById('addon-new-card-css')) return;
        const style = document.createElement('style');
        style.id = 'addon-new-card-css';
        style.textContent = `
            /* Полностью скрываем старый контент */
            .rdb-card[data-redesigned="true"] > .rdb-priority > header,
            .rdb-card[data-redesigned="true"] > .rdb-priority > .rdb-card-progress,
            .rdb-card[data-redesigned="true"] > .rdb-priority > .rdb-card-content { display: none !important; }
            .rdb-card[data-redesigned="true"] .rdb-priority { border-left: none !important; padding: 0 !important; background: transparent !important; }
            .rdb-card[data-redesigned="true"] { padding: 0 !important; border-radius: 10px !important; overflow: hidden; }

            /* Главный контейнер (компактные отступы) */
            .custom-ui-wrapper {
                display: flex; flex-direction: column; padding: 12px 14px 10px; gap: 6px;
                font-family: 'Inter', sans-serif; background: #fff;
            }

            /* Верхняя строка (Статус + Время + Звезда) */
            .c-card-top { display: flex; justify-content: space-between; align-items: flex-start; width: 100%; min-height: 24px; gap: 8px; }
            .c-card-top-right { display: flex; align-items: center; margin-left: auto; gap: 8px; }

            .c-card-status {
                font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 4px 8px;
                border-radius: 6px; letter-spacing: 0.04em; max-width: fit-content; margin: 0;
            }
            .c-card-status.s-new { background: #e0f2fe; color: #0284c7; }
            .c-card-status.s-work { background: #dbeafe; color: #1d4ed8; }
            .c-card-status.s-test { background: #fef08a; color: #a16207; }
            .c-card-status.s-pause { background: #ffedd5; color: #c2410c; }
            .c-card-status.s-done { background: #dcfce7; color: #15803d; }
            .c-card-status.s-closed { background: #f1f5f9; color: #64748b; }

            /* Трудозатраты */
            .c-card-time { font-size: 11.5px; color: #64748b; font-weight: 600; display: flex; align-items: center; gap: 4px; cursor: help; }

            /* Текст задачи */
            .c-card-body { font-size: 13.5px; line-height: 1.4; color: #334155; cursor: pointer; word-wrap: break-word; margin-bottom: 2px; }
            .c-card-id { font-weight: 700; color: #0f172a; font-size: 14px; margin-right: 0px; }
            .c-card-desc { font-weight: 400; color: #475569; }

            /* Строка тегов: выровнена по левому краю, переносится мягко */
            .c-card-tags { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; margin-bottom: 4px; }

            /* Квадратные бейджи для иконок (Приоритет, Трекер, Проект) */
            .c-icon-badge {
                display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;
                border-radius: 6px; background: #f8fafc; border: 1px solid #e2e8f0; cursor: help; flex-shrink: 0;
            }

            /* Цвета фонов для высоких приоритетов */
            .c-icon-badge.bg-critical { background: #0f172a; border-color: #0f172a; }
            .c-icon-badge.bg-high { background: #ef4444; border-color: #ef4444; }

            /* Дедлайн */
            .c-deadline {
                display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
                padding: 0 8px; border-radius: 6px; height: 26px; cursor: help; flex-shrink: 0; box-sizing: border-box;
            }
            .c-deadline.t-normal { background: #fff; border: 1px solid #e2e8f0; color: #64748b; }
            .c-deadline.t-warning { background: #f97316; border: 1px solid #f97316; color: #ffffff; }
            .c-deadline.t-expired { background: #ef4444 !important; border: 1px solid #ef4444 !important; color: #ffffff !important; }
            .c-deadline.t-none { background: #f8fafc; border: 1px dashed #cbd5e1; color: #94a3b8; font-weight: 500; }

            /* Подвал (Прогресс-бар + Аватар) */
            .c-card-footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 0; }

            /* Прогресс-бар */
            .c-card-prog-container { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; margin: 0; }
            .c-card-prog-bar { height: 4px; background: #e2e8f0; border-radius: 2px; flex: 1; overflow: hidden; }
            .c-card-prog-fill { height: 100%; background: #f59e0b; border-radius: 2px; }
            .c-card-prog-text { font-size: 11px; color: #64748b; font-weight: 600; flex-shrink: 0; display: flex; align-items: center; gap: 4px; }

            /* Аватар внизу справа (через background) */
            .c-card-avatar {
                width: 24px !important; height: 24px !important; border-radius: 50% !important; flex-shrink: 0 !important;
                background-color: #e2e8f0 !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                border: 2px solid #fff !important; box-shadow: 0 0 0 1px #cbd5e1 !important; cursor: help !important; margin: 0 !important;
            }
            .c-card-avatar span { font-size: 11px !important; line-height: 1 !important; margin: 0 !important; color: #64748b; }

            /* Кастомный тултип */
            #addon-instant-tooltip {
                position: fixed; z-index: 100000; background: #1e293b; color: #fff; padding: 6px 10px;
                border-radius: 6px; font-size: 12px; font-family: 'Inter', sans-serif; pointer-events: none;
                white-space: nowrap; box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: none; font-weight: 500;
            }
        `;
        document.head.appendChild(style);
    }

    function redesignCards() {
        let tooltipEl = document.getElementById('addon-instant-tooltip');
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'addon-instant-tooltip';
            document.body.appendChild(tooltipEl);
        }

        function positionTooltip(e) {
            let left = e.clientX + 10;
            let top = e.clientY + 15;
            const rect = tooltipEl.getBoundingClientRect();
            if (left + rect.width > window.innerWidth) left = e.clientX - rect.width - 10;
            if (top + rect.height > window.innerHeight) top = e.clientY - rect.height - 10;
            tooltipEl.style.left = left + 'px';
            tooltipEl.style.top = top + 'px';
        }

        function calculateDeadlineTooltip(dateStr) {
            const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
            if (!match) return `📅 ${dateStr}`;

            const d = parseInt(match[1], 10);
            const m = parseInt(match[2], 10) - 1;
            const y = parseInt(match[3], 10);

            const deadlineDate = new Date(y, m, d);
            deadlineDate.setHours(0,0,0,0);
            const today = new Date();
            today.setHours(0,0,0,0);

            function getWorkingDays(start, end) {
                let count = 0; let cur = new Date(start); cur.setHours(0,0,0,0);
                const endDate = new Date(end); endDate.setHours(0,0,0,0);
                while (cur <= endDate) {
                    const day = cur.getDay();
                    if (day !== 0 && day !== 6) count++;
                    cur.setDate(cur.getDate() + 1);
                }
                return count;
            }

            if (deadlineDate.getTime() === today.getTime()) {
                return '<span style="color: #fb923c;">Дедлайн сегодня!</span>';
            } else if (deadlineDate > today) {
                const nextDay = new Date(today); nextDay.setDate(nextDay.getDate() + 1);
                const wDays = getWorkingDays(nextDay, deadlineDate);
                if (wDays > 3) return `<span style="color: #34d399;">В запасе: ${wDays} раб. дн.</span>`;
                else return `<span style="color: #fb923c;">Осталось: ${wDays} раб. дн.</span>`;
            } else {
                const nextDayAfterDeadline = new Date(deadlineDate); nextDayAfterDeadline.setDate(nextDayAfterDeadline.getDate() + 1);
                const wDays = getWorkingDays(nextDayAfterDeadline, today);
                return `<span style="color: #f87171;">Просрочено: ${wDays} раб. дн.</span>`;
            }
        }

        // Хелпер: Иконки из Jira с учетом заливки фона
        function getPriorityIcon(classList) {
            if (classList.contains('rdb-priority-6')) return { text: 'Критический', badgeClass: 'bg-critical', svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m19 11-7-7-7 7"/><path d="m19 18-7-7-7 7"/></svg>' };
            if (classList.contains('rdb-priority-high')) return { text: 'Высокий', badgeClass: 'bg-high', svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m19 15-7-7-7 7"/></svg>' };
            if (classList.contains('rdb-priority-medium')) return { text: 'Средний', badgeClass: '', svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="8" x2="19" y2="8"/><line x1="5" y1="16" x2="19" y2="16"/></svg>' };
            if (classList.contains('rdb-priority-low')) return { text: 'Низкий', badgeClass: '', svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 6 7 7 7-7"/><path d="m5 13 7 7 7-7"/></svg>' };
            return { text: 'Нормальный', badgeClass: '', svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b940" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 9 7 7 7-7"/></svg>' };
        }

        // Хелпер: Иконки трекера
        function getTrackerIcon(trackerText) {
            const text = trackerText.toLowerCase();

            // Баги и инциденты (Остается цветным: Белый круг в красно-оранжевом квадрате)
            if (text.includes('баг') || text.includes('инцидент') || text.includes('ошибка')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#f05232"/><circle cx="12" cy="12" r="5" fill="#ffffff"/></svg>';

            // Структурная (Остается цветной: Фиолетовая молния)
            if (text.includes('структур')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';

            // Разработка / Разработка ЭП / Разработка (new) (Серый код </>)
            if (text.includes('разработ')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';

            // Аналитика / Аналитика (new) (Упрощенная серая лампочка)
            if (text.includes('аналитик')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14a6 6 0 1 0-6 0v4h6v-4Z"/></svg>';

            // Сопровождение / Сопровождение (new) (Серый Щит)
            if (text.includes('сопровожд') || text.includes('тп')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

            // Выделение выч.мощности (Серый сервер)
            if (text.includes('выч.мощност') || text.includes('выделен')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';

            // Типовая задача (Серая Шестеренка)
            if (text.includes('типов')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

            // Коммуникации (Серое диалоговое облако)
            if (text.includes('коммуникац')) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

            // Дефолтная иконка для неучтенных типов
            return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
        }

        document.querySelectorAll('.rdb-issue').forEach(issue => {
            const cardNode = issue.querySelector('.rdb-card');
            if (!cardNode || cardNode.hasAttribute('data-redesigned')) return;
            cardNode.setAttribute('data-redesigned', 'true');

            const priorityWrapper = cardNode.querySelector('.rdb-priority');
            if (!priorityWrapper) return;

            // --- 1. ПАРСИНГ ---
            const idNode = issue.querySelector('.rdb-menu-link');
            const taskId = idNode ? idNode.textContent.trim() : '';
            const viewLink = idNode ? idNode.closest('.rdb-menu-issue').querySelector('a[href*="/issues/"]')?.href : null;

            const subjectNode = issue.querySelector('.rdb-card-subject');
            const subjectText = subjectNode ? subjectNode.textContent.trim() : '';

            const projectNode = issue.querySelector('.rdb-card-content > div:not([class])') || issue.querySelector('.rdb-card-content > div:nth-child(2)');
            const projectText = projectNode ? projectNode.textContent.trim() : '';

            const trackerNode = issue.querySelector('.rdb-property-tracker');
            const trackerText = trackerNode ? trackerNode.textContent.trim() : '';

            const deadlineNode = issue.querySelector('.rdb-deadline-badge');
            let deadlineText = deadlineNode ? deadlineNode.textContent.trim().replace(/Deadline:\s*/i, '').replace(/до\s*/i, '').trim() : '';
            let dlClass = 't-normal';
            if (deadlineNode) {
                if (deadlineNode.classList.contains('deadline-expired')) dlClass = 't-expired';
                else if (deadlineNode.classList.contains('deadline-warning')) dlClass = 't-warning';
            }

            const assigneeNode = issue.querySelector('.rdb-property-assignee');
            const assigneeText = assigneeNode ? assigneeNode.textContent.trim() : 'Не назначен';

            const avatarNode = issue.querySelector('img.gravatar');
            const avatarSrc = avatarNode ? avatarNode.src : '';

            // Трудозатраты
            const timeNode = issue.querySelector('.rdb-property-time');
            let timeText = '0.0 / 0.0';
            if (timeNode) {
                const spans = timeNode.querySelectorAll('span');
                if (spans.length >= 2) {
                    const t1 = spans[0].textContent.trim() || '0.0';
                    const t2 = spans[1].textContent.trim() || '0.0';
                    timeText = `${t1} / ${t2}`;
                } else {
                    const txt = timeNode.textContent.trim();
                    if (txt) timeText = txt;
                }
            }

            // Статус
            const statusEl = issue.querySelector('.rdb-property-status');
            const statusText = statusEl ? statusEl.textContent.trim() : 'Новая';
            let sClass = 's-new';
            const sTextLow = statusText.toLowerCase();
            if (sTextLow.includes('в работе') || sTextLow.includes('разработ')) sClass = 's-work';
            else if (sTextLow.includes('тест')) sClass = 's-test';
            else if (sTextLow.includes('пауз') || sTextLow.includes('ожидан')) sClass = 's-pause';
            else if (sTextLow.includes('готов') || sTextLow.includes('релиз') || sTextLow.includes('решен')) sClass = 's-done';
            else if (sTextLow.includes('закр') || sTextLow.includes('отмен') || sTextLow.includes('не актуал')) sClass = 's-closed';

            const prioData = getPriorityIcon(priorityWrapper.classList);
            const trackerSVG = getTrackerIcon(trackerText);
            const progNode = issue.querySelector('.rdb-card-progress-bar');
            const progPercent = progNode && progNode.style.width ? progNode.style.width : '0%';

            // Логика отображения дедлайна с SVG вместо эмодзи
            const deadlineSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

            let deadlineHtml = '';
            if (deadlineText) {
                deadlineHtml = `<div class="c-deadline ${dlClass}" data-deadline="${deadlineText}">${deadlineSvg} ${deadlineText}</div>`;
            } else {
                deadlineHtml = `<div class="c-deadline t-none" data-tooltip="Дедлайн не задан">${deadlineSvg} Не задано</div>`;
            }

            // --- 2. ГЕНЕРАЦИЯ ---
            const newUI = document.createElement('div');
            newUI.className = 'custom-ui-wrapper';
            newUI.innerHTML = `
                <div class="c-card-top">
                    <span class="c-card-id">${taskId}</span>
                    <div class="c-card-status ${sClass}">${statusText}</div>
                    <div class="c-card-top-right">
                        <!-- Звезда добавится сюда программно -->
                    </div>
                </div>

                <div class="c-card-body">
                    <span class="c-card-desc">${subjectText}</span>
                </div>

                <div class="c-card-tags">
                    <div class="c-icon-badge ${prioData.badgeClass || ''}" data-tooltip="Приоритет: ${prioData.text}">${prioData.svg}</div>
                    ${trackerText ? `<div class="c-icon-badge" data-tooltip="Тип задачи: ${trackerText}">${trackerSVG}</div>` : ''}
                    ${projectText ? `<div class="c-icon-badge" data-tooltip="Проект: ${projectText}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></div>` : ''}
                    ${deadlineHtml}
                </div>

                <div class="c-card-footer">
                    <div class="c-card-time" data-tooltip="Затраченное время / Оценка">⏳ ${timeText}</div>
                    <div class="c-card-prog-container">
                        <div class="c-card-prog-bar"><div class="c-card-prog-fill" style="width: ${progPercent};"></div></div>
                        <div class="c-card-prog-text" data-tooltip="Прогресс выполнения задачи">
                            ${progPercent}
                        </div>
                    </div>
                    <div class="c-card-avatar" data-tooltip="👤 ${assigneeText}" ${avatarSrc ? `style="background-image: url('${avatarSrc}');"` : ''}>
                        ${avatarSrc ? '' : `<span>👤</span>`}
                    </div>
                </div>
            `;

            priorityWrapper.appendChild(newUI);

            // --- 3. ТУЛТИПЫ И КЛИКИ ---
            newUI.querySelectorAll('[data-tooltip], [data-deadline]').forEach(el => {
                el.addEventListener('mouseenter', (e) => {
                    let text = el.getAttribute('data-tooltip');
                    if (el.hasAttribute('data-deadline')) text = calculateDeadlineTooltip(el.getAttribute('data-deadline'));
                    if (text) {
                        tooltipEl.innerHTML = text;
                        tooltipEl.style.display = 'block';
                        positionTooltip(e);
                    }
                });
                el.addEventListener('mousemove', (e) => { if (tooltipEl.style.display === 'block') positionTooltip(e); });
                el.addEventListener('mouseleave', () => tooltipEl.style.display = 'none');
            });

            // Клик для Iframe
            const bodyNode = newUI.querySelector('.c-card-body');
            if (viewLink) {
                let startX = 0, startY = 0;
                bodyNode.addEventListener('mousedown', (e) => { startX = e.clientX; startY = e.clientY; });
                bodyNode.addEventListener('click', (e) => {
                    if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) return;
                    e.preventDefault(); e.stopPropagation();
                    if (typeof openModal === 'function') openModal(viewLink, issue);
                });
            }
        });
    }

    // отрисовка звездочек на карточках
    function initFavoriteStars() {
        const FAV_KEY = 'addon_favorite_tasks';
        const getFavs = () => JSON.parse(localStorage.getItem(FAV_KEY) || '[]');

        function renderStars() {
            const favs = getFavs();
            const cards = document.querySelectorAll('.rdb-card');

            cards.forEach(card => {
                const idLink = card.querySelector('.rdb-menu-link');
                if (!idLink) return;
                const taskId = idLink.textContent.trim().replace('#', '');
                const isFav = favs.some(f => f.id === taskId);

                const topRightContainer = card.querySelector('.c-card-top-right');
                if (!topRightContainer) return;

                let starEl = topRightContainer.querySelector('.addon-fav-star-container');

                if (isFav) {
                    if (!starEl) {
                        starEl = document.createElement('div');
                        starEl.className = 'addon-fav-star-container';
                        starEl.style.cssText = 'display: flex; align-items: center; color: #f59e0b; cursor: pointer; padding: 2px;';
                        starEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

                        topRightContainer.appendChild(starEl);
                    }
                } else {
                    if (starEl) starEl.remove();
                }
            });
        }

        renderStars();
        return renderStars;
    }






    function initUI() {
        if (document.getElementById('addon-overlay')) return;

        overlay = document.createElement('div');
        overlay.id = 'addon-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(15, 23, 42, 0.4)', zIndex: '9999',
            display: 'none', opacity: '0', transition: 'opacity 0.3s ease',
            backdropFilter: 'blur(3px)'
        });

        modal = document.createElement('div');
        Object.assign(modal.style, {
            position: 'fixed',
            backgroundColor: 'white',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)',
            borderRadius: '12px 12px 0 0',
            overflow: 'hidden',
            zIndex: '10000',
            display: 'none'
        });

        buttonContainer = document.createElement('div');
        Object.assign(buttonContainer.style, {
            position: 'absolute', top: '15px', right: '15px',
            display: 'flex', gap: '8px', zIndex: '10001',
            opacity: '0', transition: 'opacity 0.2s ease'
        });

        const createBtn = (svg, title, onClick) => {
            const btn = document.createElement('div');
            btn.innerHTML = svg;
            btn.title = title;
            Object.assign(btn.style, {
                width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                backgroundColor: '#f1f5f9', color: '#64748b', borderRadius: '10px', cursor: 'pointer', transition: 'all 0.2s ease'
            });
            btn.onmouseenter = () => { btn.style.backgroundColor = '#e2e8f0'; btn.style.color = '#0f172a'; };
            btn.onmouseleave = () => { btn.style.backgroundColor = '#f1f5f9'; btn.style.color = '#64748b'; };

            btn.onclick = (e) => {
                e.stopPropagation();
                const iframe = modal.querySelector('iframe');
                let currentUrl = null;

                if (iframe) {
                    try {
                        //пытаемся забрать АКТУАЛЬНЫЙ адрес, на котором сейчас находится айфрейм
                        // Это сработает только если находимся в редмайне, на внешние ссылки у айфрейма не будет доступа! По большому счету эта фича позволяет копировать страницу на которой мы находимся, а не только карточку задачи которая изначально была открыта в окне
                        currentUrl = iframe.contentWindow.location.href;
                    } catch (err) {
                        //сработает защита CORS, если вы перешли на внешний сайт (не pr.isands.ru)
                        //в этом случае достать новую ссылку технически невозможно, пишем алерт в консольку
                        console.warn('CORS: Невозможно получить внешнюю ссылку. Используем исходную.');
                        currentUrl = iframe.src;
                    }
                }

                //передаем фактический URL в кнопку (копирование, новая вкладка или рефреш), орпять же только для редмайна
                onClick(currentUrl, btn);
            };
            return btn;
        };

        buttonContainer.appendChild(createBtn(
            `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
            'Копировать ссылку',
            (url, btn) => {
                if (url) {
                    navigator.clipboard.writeText(url);
                    const originalBg = btn.style.backgroundColor;
                    btn.style.backgroundColor = '#86efac';
                    setTimeout(() => btn.style.backgroundColor = originalBg, 300);
                }
            }
        ));

        buttonContainer.appendChild(createBtn(
            `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`,
            'Открыть в новой вкладке',
            (url) => { if (url) window.open(url, '_blank'); }
        ));

        buttonContainer.appendChild(createBtn(
            `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`,
            'Обновить страницу',
            (url) => {
                const iframe = modal.querySelector('iframe');
                if (iframe && url) {
                    //возвращаем лоадер, чтобы было понятно, что идет процесс обновления страницы
                    if (!modal.querySelector('.addon-loader')) {
                        const loader = document.createElement('div');
                        loader.className = 'addon-loader';
                        modal.appendChild(loader);
                    }
                    //скрываем все в айфрейме, пока он грузится, иначе нагружаем ЦП из-за скейлинга и анимашка тормозит
                    iframe.style.opacity = '0';
                    //перезагрукза (присвоение src заново вызовет iframe.onload, который уберет лоадер и покажет айфрейм)
                    iframe.src = url;
                }
            }
        ));

        buttonContainer.appendChild(createBtn(
            `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
            'Закрыть (Esc)',
            () => closeModal()
        ));

        modal.appendChild(buttonContainer);
        document.body.appendChild(overlay);
        document.body.appendChild(modal);

        overlay.addEventListener('click', () => {
            if (!isModalLocked) closeModal(); // Закрываем только если НЕ заблокировано (защита от мисклика при создании новой таски, выше писал об этом в начале файла)
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!isModalLocked) closeModal(); // то же самое про блокировку айфрейма только на кнопку на клаве уыс
            }
        });
    }

    //это рудимент, т.к. я убрал скролл, но выпиливать не стал, вдруг кому понадобится. Чтобы вернуть скролл на доске нужно залезть в расширение стилус и там закомментить строку "scrollbar-width: none;" для #wrapper
    //надо еще дописать свойство border-right здесь для открывшегося контента в айфрейм и задать ширину == scrollbar-width иначе все будет люто флексить при открытии айфрейма
    function getScrollbarWidth() { return window.innerWidth - document.documentElement.clientWidth; }

    //сортируем таски на доске по приоритету. См PRIORITY_WEIGHTS для изменения последовательности (выше в коде здесь)
    function sortIssues() {
        const columns = document.querySelectorAll('.rdb-column');
        columns.forEach(col => {
            const issues = Array.from(col.querySelectorAll('.rdb-issue'));
            if (issues.length === 0) return;
            const container = issues[0].parentNode;
            const nonIssues = Array.from(container.children).filter(el => !el.classList.contains('rdb-issue'));

            issues.sort((a, b) => {
                const getWeight = (el) => {
                    const prioEl = el.querySelector('.rdb-priority');
                    if (!prioEl) return 0;
                    for (const cls of prioEl.classList) {
                        // Ищем класс в нашем конфиге
                        const configItem = PRIORITIES_CONFIG.find(p => p.id === cls);
                        if (configItem) return configItem.weight;
                    }
                    return 0;
                };
                return getWeight(b) - getWeight(a); // По убыванию веса
            });

            issues.forEach((issue, index) => {
                if (container.children[index] !== issue) container.insertBefore(issue, container.children[index]);
            });

            nonIssues.forEach(el => {
                if (el.parentNode !== container || Array.from(container.children).indexOf(el) < issues.length) {
                    container.appendChild(el);
                }
            });
        });
    }



    function applyEnhancements() {
        // стили для номера задачи (выполняется 1 раз)
        if (!document.getElementById('addon-task-number-fix')) {
            const style = document.createElement('style');
            style.id = 'addon-task-number-fix';
            style.textContent = `
                /* Делаем номер задачи идентичным имени сотрудника */
                .rdb-menu-issue .rdb-menu-link[data-killed="true"] {
                    color: #334155 !important;
                    font-weight: 500 !important;
                    font-size: 14px !important;
                    background: transparent !important; /* Убиваем фоновые стрелки */
                    padding-left: 8px !important;       /* Возвращаем отступ от левой рамки */
                    padding-right: 4px !important;
                    pointer-events: none !important;    /* Полностью глушим клики */
                    text-decoration: none !important;
                }
                /* Выжигаем стрелочки, если они сделаны через псевдо-элементы */
                .rdb-menu-issue .rdb-menu-link[data-killed="true"]::after,
                .rdb-menu-issue .rdb-menu-link[data-killed="true"]::before {
                    display: none !important;
                    content: none !important;
                }
            `;
            document.head.appendChild(style);
        }


        document.querySelectorAll('.rdb-menu-issue .rdb-menu-link:not([data-killed])').forEach(link => {
            link.setAttribute('data-killed', 'true');
            link.removeAttribute('style'); // Очищаем весь мусор, чтобы работал CSS выше
        });


        //открываем iframe по клику на название
        document.querySelectorAll('.rdb-card-subject:not([data-has-click])').forEach(subject => {
            subject.setAttribute('data-has-click', 'true');
            subject.style.cursor = 'pointer';

            const cardEl = subject.closest('.rdb-issue') || subject.closest('.rdb-card');
            const viewLink = cardEl ? cardEl.querySelector('a[href*="/issues/"]')?.href : null;

            if (viewLink) {
                let startX = 0; let startY = 0;
                subject.addEventListener('mousedown', (e) => {
                    startX = e.clientX; startY = e.clientY;
                });
                subject.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const diffX = Math.abs(e.clientX - startX);
                    const diffY = Math.abs(e.clientY - startY);
                    if (diffX > 5 || diffY > 5) return; // Если тащили карточку игнорируем
                    openModal(viewLink, cardEl);
                });
            }
        });

        document.querySelectorAll('.rdb-property-tracker:not([data-colored])').forEach(el => {
            const text = el.textContent.trim().toLowerCase();
            const types = { 'аналитика': 'analytics', 'разработка': 'dev', 'сопровождение': 'support', 'типовая': 'standard' };
            const type = Object.keys(types).find(k => text.includes(k)) || 'default';
            el.setAttribute('data-tracker-type', types[type]);
            el.setAttribute('data-colored', 'true');
        });


        // подсвечиваем дедлайны
        const now = new Date(); now.setHours(0, 0, 0, 0);
        document.querySelectorAll('.rdb-card-content div').forEach(div => {
            const match = div.textContent.trim().match(deadlineRegex);
            if (match && !div.classList.contains('rdb-deadline-badge')) {
                div.classList.add('rdb-deadline-badge');
                const d = new Date(match[4], match[3] - 1, match[2]);
                const diff = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
                div.classList.add(diff < 0 ? 'deadline-expired' : (diff <= 3 ? 'deadline-warning' : 'deadline-normal'));
            }
        });

        // НОВАЯ СТРОКА: Вызываем перерисовку после того, как все базовые данные собраны
        redesignCards();
    }

    // метод для открытия айфрейма с конкретной таской
    function openModal(url, sourceEl = null, locked = false) {
        initUI(); //гарантируем, что UI инициализирован
        isModalLocked = locked; //сохраняем состояние блокировки айфрейма

        // очищаем старые состояния
        if (pulseTimer) clearTimeout(pulseTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        document.querySelectorAll('.rdb-highlight-pulse').forEach(el => el.classList.remove('rdb-highlight-pulse'));

        // очистка и подготовка модалки
        modal.innerHTML = '';
        modal.appendChild(buttonContainer);

        activeSourceElement = sourceEl;

        //достаем ID задачи из URL
        const matchId = url ? url.match(/\/issues\/(\d+)/) : null;
        activeIssueId = matchId ? matchId[1] : null;

        document.body.style.overflow = 'hidden';

        //показываем оверлей и модалку
        overlay.style.display = 'block';
        setTimeout(() => overlay.style.opacity = '1', 0);
        modal.style.display = 'block';
        buttonContainer.style.opacity = '0';


        // Анимация
        if (sourceEl) {
            const rect = sourceEl.getBoundingClientRect();
            modal.style.transition = 'none';
            modal.style.top = rect.top + 'px';
            modal.style.left = rect.left + 'px';
            modal.style.width = rect.width + 'px';
            modal.style.height = rect.height + 'px';
            modal.style.opacity = '0.5';
            void modal.offsetWidth;
            modal.style.transition = 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.35s ease';
        } else {
            //позиционирование для создания задачи, чтобы айфрейм не тикал с экрана
            const h = window.innerHeight * 0.93;
            const t = window.innerHeight - h;
            const w = PREVIEW_WIDTH;
            const l = (window.innerWidth - w) / 2;

            modal.style.transition = 'opacity 0.3s ease';
            modal.style.transform = ''; //убираем transform, он мешает позиционке
            modal.style.top = t + 'px';
            modal.style.left = l + 'px';
            modal.style.width = w + 'px';
            modal.style.height = h + 'px';
            modal.style.opacity = '0';
        }

        requestAnimationFrame(() => {
            const targetWidth = PREVIEW_WIDTH;
            const targetHeight = window.innerHeight * 0.93;
            const targetLeft = (window.innerWidth - targetWidth) / 2;
            const targetTop = window.innerHeight - targetHeight;

            if (sourceEl) {
                modal.style.top = targetTop + 'px';
                modal.style.left = targetLeft + 'px';
                modal.style.width = targetWidth + 'px';
                modal.style.height = targetHeight + 'px';
            }
            modal.style.opacity = '1';

            setTimeout(() => {
                buttonContainer.style.opacity = '1';

                const loader = document.createElement('div');
                loader.className = 'addon-loader';
                modal.appendChild(loader);

                const iframe = document.createElement('iframe');
                iframe.style.cssText = "width:100%; height:100%; border:none; opacity: 0; transition: opacity 0.3s ease;";

                //тут мы инжектируем стили внутрь айфрейма
                const injectStyles = () => {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        if (!doc || !doc.head) return;
                        if (!doc.getElementById('clean-view-css')) {
                            const style = doc.createElement('style');
                            style.id = 'clean-view-css';
                            //скрываем лишнее внутри iframe
                             style.textContent = `
                                html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
                                html, body { -ms-overflow-style: none; scrollbar-width: none; background: #ffffff !important; }
                                #wrapper { background: #ffffff !important; }
                                #header, #top-menu, #sidebar { display: none !important; }
                                .drdn { display: none; }
                                #main { padding-top: 10px !important; margin: 0 !important; }
                                div#content > h2 { padding-top: 10px !important; margin-top: -10px; }
                                div#content { margin-right: 0px; }
                                #content { border: none !important; box-shadow: none !important; width: auto !important; }
                                div#content > div.contextual, .controller-timelog div#content .contextual, .controller-time_entry_reports div#content .contextual {
                                    margin-top: 0 !important; margin-right: 190px !important;
                                }
                                .contextual a.icon { background-image: none !important; padding: 5px 10px !important; display: inline-block !important; }
                                .contextual a.icon::before { display: none !important; }
                                .contextual a.icon, .contextual .drdn-trigger {
                                    border: 1px solid #d1d5db; background-color: #f3f4f6; border-radius: 4px; color: #374151 !important; text-decoration: none !important; font-size: 12px; margin-left: 5px;
                                }
                            `;
                            doc.head.appendChild(style);
                        }
                    } catch (e) {}
                };

                const interval = setInterval(injectStyles, 500);

                iframe.onload = () => {
                    clearInterval(interval);
                    injectStyles();

                    //добавляем название проекта в заголовок к задаче
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        const projectSpan = doc.querySelector('.current-project');
                        const h2 = doc.querySelector('div#content > h2.inline-flex') || doc.querySelector('div#content > h2');

                        if (projectSpan && h2 && !doc.getElementById('addon-project-badge')) {
                            const projectName = projectSpan.textContent.trim();

                            // создаем надпись с названием проекта
                            const projectLabel = doc.createElement('span');
                            projectLabel.id = 'addon-project-badge';
                            projectLabel.textContent = projectName;

                            Object.assign(projectLabel.style, {
                                fontSize: '16px',
                                fontWeight: '600',
                                color: '#64748b',
                                lineHeight: '1'
                            });

                            Object.assign(h2.style, {
                                display: 'inline-flex',
                                flexDirection: 'column',
                                alignItems: 'flex-start',
                                fontSize: '16px', // уменьшаем основной шрифт с 24px до 16px
                            });

                            //название проекта ПЕРЕД оригинальным текстом H2
                            h2.insertBefore(projectLabel, h2.firstChild);

                           //сворачиваем блок с файлами
                        const attachmentsDiv = doc.querySelector('.attachments');
                        if (attachmentsDiv) {
                            const filesHeader = attachmentsDiv.previousElementSibling;

                            if (filesHeader && filesHeader.tagName.toLowerCase() === 'p' && filesHeader.textContent.includes('Файлы')) {

                                //читаем настройку (по умолчанию сворачиваем)
                                let isCollapsedByDefault = localStorage.getItem('addon_files_collapsed_default') !== 'false';
                                let isCurrentlyHidden = isCollapsedByDefault;
                                attachmentsDiv.style.display = isCurrentlyHidden ? 'none' : 'block';

                                //перестраиваем заголовок
                                const originalText = 'Файлы';
                                filesHeader.style.display = 'inline-flex';
                                filesHeader.style.alignItems = 'center';
                                filesHeader.style.gap = '8px';
                                filesHeader.style.userSelect = 'none';
                                filesHeader.style.position = 'relative';
                                filesHeader.innerHTML = '';

                                const titleSpan = doc.createElement('span'); // чтобы можно было кликнуть на текст
                                titleSpan.style.cursor = 'pointer';
                                titleSpan.style.fontWeight = 'bold';
                                titleSpan.innerHTML = (isCurrentlyHidden ? '► ' : '▼ ') + originalText;

                                //иконка естеренки
                                const cogSpan = doc.createElement('span');
                                cogSpan.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
                                cogSpan.style.cursor = 'pointer';
                                Object.assign(cogSpan.style, {
                                    display: 'flex', alignItems: 'center', padding: '0px', borderRadius: '4px'
                                });
                                cogSpan.onmouseenter = () => cogSpan.style.backgroundColor = '#f1f5f9';
                                cogSpan.onmouseleave = () => cogSpan.style.backgroundColor = 'transparent';

                                //модалка с переключателем
                                const settingsMenu = doc.createElement('div');
                                Object.assign(settingsMenu.style, {
                                    position: 'absolute',
                                    top: '100%',
                                    left: '0',
                                    marginTop: '6px',
                                    backgroundColor: '#fff',
                                    border: '1px solid #e2e8f0',
                                    borderRadius: '8px',
                                    boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                                    padding: '10px 12px',
                                    minWidth: '220px',
                                    zIndex: '1000',
                                    display: 'none',
                                    fontFamily: "'Inter', sans-serif",
                                    fontWeight: 'normal',
                                    cursor: 'default'
                                });

                                settingsMenu.innerHTML = `
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span style="font-size: 13px; color: #334155;">Сворачивать по умолчанию</span>
                                        <label style="position: relative; display: inline-block; width: 32px; height: 18px; margin: 0;">
                                            <input type="checkbox" id="addon-files-toggle" style="opacity: 0; width: 0; height: 0;" ${isCollapsedByDefault ? 'checked' : ''}>
                                            <span id="addon-files-slider" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${isCollapsedByDefault ? '#3b82f6' : '#cbd5e1'}; transition: .2s; border-radius: 18px;">
                                                <span id="addon-files-knob" style="position: absolute; content: ''; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: .2s; border-radius: 50%; transform: ${isCollapsedByDefault ? 'translateX(14px)' : 'translateX(0)'};"></span>
                                            </span>
                                        </label>
                                    </div>
                                `;

                                filesHeader.appendChild(titleSpan);
                                filesHeader.appendChild(cogSpan);
                                filesHeader.appendChild(settingsMenu);

                                // логика ручного сворачивания (клик по тексту)
                                titleSpan.addEventListener('click', () => {
                                    isCurrentlyHidden = !isCurrentlyHidden;
                                    attachmentsDiv.style.display = isCurrentlyHidden ? 'none' : 'block';
                                    titleSpan.innerHTML = (isCurrentlyHidden ? '► ' : '▼ ') + originalText;
                                });

                                // Логика открытия/закрытия меню (клик по шестеренке)
                                cogSpan.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    settingsMenu.style.display = settingsMenu.style.display === 'block' ? 'none' : 'block';
                                });

                                //Закрытие меню при клике вне его области (внутри iframe)
                                doc.addEventListener('click', (e) => {
                                    if (!filesHeader.contains(e.target)) {
                                        settingsMenu.style.display = 'none';
                                    }
                                });

                                const filesToggle = settingsMenu.querySelector('#addon-files-toggle');
                                const filesSlider = settingsMenu.querySelector('#addon-files-slider');
                                const filesKnob = settingsMenu.querySelector('#addon-files-knob');

                                filesToggle.addEventListener('change', (e) => {
                                    const isChecked = e.target.checked;
                                    localStorage.setItem('addon_files_collapsed_default', isChecked);

                                    //анимашка
                                    filesSlider.style.backgroundColor = isChecked ? '#3b82f6' : '#cbd5e1';
                                    filesKnob.style.transform = isChecked ? 'translateX(14px)' : 'translateX(0)';
                                });
                            }
                        }
                        }
                    } catch (e) {
                    }

                    setTimeout(() => {
                        const activeLoader = modal.querySelector('.addon-loader');
                        if (activeLoader) activeLoader.remove();

                        iframe.style.opacity = '1';
                    }, 100);
                };

                iframe.src = url;
                modal.appendChild(iframe);
            }, 150);
        });
    }

    function closeModal() {
        isModalLocked = false;
        overlay.style.opacity = '0';
        buttonContainer.style.opacity = '0';

        // очищаем анимации
        if (pulseTimer) clearTimeout(pulseTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        document.querySelectorAll('.rdb-highlight-pulse').forEach(el => el.classList.remove('rdb-highlight-pulse'));

        // убиваем iframe
        const iframe = modal.querySelector('iframe');
        if (iframe) {
            iframe.remove();
        }

        //пытаемся найти свежий элемент карточки на доске перед сворачиванием, щдесь исправляем баг связанный с рефрешером, когда анимация уходила вникуда
        if (activeIssueId) {
            let freshEl = document.querySelector(`.rdb-issue[data-rdb-issue-id="${activeIssueId}"]`);

            if (!freshEl) {
                const linkEl = document.querySelector(`.addon-compact-card a[href*="/issues/${activeIssueId}"]`);
                if (linkEl) freshEl = linkEl.closest('.addon-compact-card');
            }

            //обновляем целевой элемент для анимации (если не нашли - будет null, и анимация уйдет вниз)
            activeSourceElement = freshEl || null;
        }

        if (activeSourceElement) {
            // сворачивание айфрейма в актуальную карточку
            const rect = activeSourceElement.getBoundingClientRect();
            modal.style.top = rect.top + 'px';
            modal.style.left = rect.left + 'px';
            modal.style.width = rect.width + 'px';
            modal.style.height = rect.height + 'px';
            modal.style.opacity = '0.5';

            // выделение карточки при сворачивании, чтобы она моргнула
            pulseTimer = setTimeout(() => {
                if (activeSourceElement) {
                    activeSourceElement.classList.add('rdb-highlight-pulse');
                    cleanupTimer = setTimeout(() => {
                        if (activeSourceElement) activeSourceElement.classList.remove('rdb-highlight-pulse');
                    }, 500);
                }
            }, 250);

        } else {
            // карточка пропала с доски или это была форма "Создать задачу"
            modal.style.transform = 'translateY(100%)';
            modal.style.opacity = '0';
        }

        setTimeout(() => {
            overlay.style.display = 'none';
            modal.style.display = 'none';
            modal.style.transform = '';
            if (iframe) iframe.remove();
            document.body.style.overflow = ''; document.body.style.paddingRight = '';

            activeSourceElement = null;
            activeIssueId = null;

            // рефрешер
            if (localStorage.getItem('addon_autorefresh') === 'true') {
                const refreshBtn = document.getElementById('rdb-refresh');
                if (refreshBtn) {
                    console.log('Addon: Auto-refresh triggered');
                    refreshBtn.click();
                }
            }
        }, 250);
    }
    // =================================================================================
    // ЧАСТЬ 2: ТАБЛИЦЫ
    // =================================================================================

    const PRIORITY_COLORS_TABLE = {
        'priority-1': '#94a3b8', 'priority-2': '#64748b', 'priority-3': '#f59e0b',
        'priority-4': '#ea580c', 'priority-5': '#dc2626', 'priority-default': '#3b82f6'
    };

    //тупо накидываем стиля на подзадачи и связанные задачи
    function injectTableStyles() {
        if (document.getElementById('addon-table-styles')) return;
        const style = document.createElement('style');
        style.id = 'addon-table-styles';
        style.textContent = `
            #issue_tree table.list.issues,
            #relations table.list.issues { display: none !important; }

            .addon-compact-list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; margin-top: 5px; }

            .addon-compact-card {
                display: flex; align-items: center; background: #fff;
                border: 1px solid #e2e8f0; border-radius: 4px; padding: 6px 10px;
                transition: all 0.2s; gap: 10px; min-height: 28px;
            }
            .addon-compact-card:hover { border-color: #94a3b8; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }

            .card-dimmed { opacity: 0.6; background-color: #f8fafc; border-color: #e2e8f0; }
            .card-dimmed:hover { opacity: 0.9; background-color: #fff; }

            .tag-blocking {
                background-color: #e11d48 !important; color: #ffffff !important; border-color: #e11d48 !important;
            }
            .tag-blockiruet {
                background-color: color: #ffffff !important; border-color: #f97316 !important;
            }

            .addon-icon { width: 14px; height: 14px; flex-shrink: 0; margin-right: 6px; margin-left: 2px; stroke-width: 2.5; }
            .icon-green { color: #16a34a; }
            .icon-red   { color: #dc2626; fill: #dc2626; border: none; }
            .icon-orange { color: #ea580c; }

            .addon-main-info { flex-grow: 1; display: flex; align-items: center; gap: 4px; overflow: hidden; cursor: default; }

            .addon-relation-tag {
                font-size: 11px; text-transform: lowercase; color: #475569; font-weight: 600;
                background: #f1f5f9; padding: 2px 6px; border-radius: 4px; white-space: nowrap; border: 1px solid #e2e8f0;
                margin-right: 4px;
            }

            .addon-summary {
                font-size: 13px; font-weight: 500; color: #334155;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                cursor: pointer; transition: color 0.2s; text-decoration: none; display: block;
            }
            .addon-summary:hover { color: #2563eb; text-decoration: underline; }

            .addon-meta { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #64748b; flex-shrink: 0; }

            .addon-status { padding: 3px 10px; border-radius: 12px; font-weight: 500; white-space: nowrap; font-size: 12px; }
            .st-step-1 { background: #f3f4f6; color: #4b5563; }
            .st-step-2 { background: #7dd3fc; color: #0c4a6e; }
            .st-step-3 { background: #a5b4fc; color: #1e1b4b; }
            .st-step-4 { background: #c084fc; color: #3b0764; }
            .st-step-5 { background: #e879f9; color: #4a044e; }
            .st-step-6 { background: #2dd4bf; color: #042f2e; }
            .st-step-7 { background: #bef264; color: #1a2e05; }
            .st-step-8 { background: #86efac; color: #14532d; }
            .st-warn { background: #fdba74; color: #7c2d12; }
            .st-stop { background: #fca5a5; color: #7f1d1d; }
            .st-closed { background: #f1f5f9; color: #94a3b8; text-decoration: line-through; }

            .addon-user { min-width: 110px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }

            .addon-date-badge {
                display: inline-flex; align-items: center; justify-content: center;
                padding: 0 4px; border-radius: 4px; font-size: 12px; font-weight: 500;
                white-space: nowrap; height: 20px; box-sizing: border-box; min-width: 100px;
            }
            .date-normal { background: #fff; border: 1px solid #cbd5e1; color: #334155; }
            .date-warn-filled { background: #f97316; border: 1px solid #f97316; color: #fff; }
            .date-over-filled { background: #e11d48; border: 1px solid #e11d48; color: #fff; }
            .date-empty-badge { background: #fff; border: 1px solid #e2e8f0; color: #94a3b8; }

            .addon-actions a { color: #cbd5e1; text-decoration: none; font-size: 16px; line-height: 1; display: flex; align-items: center; transition: color 0.2s; cursor: pointer; }
            .addon-actions a:hover { color: #ef4444; }
        `;
        document.head.appendChild(style);
    }

    //тут делаем все про таблицы подзадач и связаных задач, не трогай, пока работает!!!!!
    function parseAndTransformTable(containerId, listId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const table = container.querySelector('table.list.issues');
        if (!table) return;

        let list = document.getElementById(listId);
        if (list) list.remove();

        const releaseBlockId = listId + '-release-wrapper';
        let releaseBlock = document.getElementById(releaseBlockId);
        if (releaseBlock) releaseBlock.remove();

        //создаем контейнеры для элементов
        list = document.createElement('div');
        list.id = listId;
        list.className = 'addon-compact-list';

        let releaseListContainer = null;

        const rows = table.querySelectorAll('tr.issue');
        if (rows.length === 0) return;

        let hasBlocker = false;
        let hasReleases = false;

        const KNOWN_RELATIONS = ['связана с', 'блокируется', 'блокирует', 'дублируется', 'дублирует', 'следующая', 'предыдущая', 'скопирована с', 'скопирована в'];
        const releaseRegex = /^Релиз\s+\d+\.\d+\.\d+/i;

        rows.forEach(row => {
            const subjectLink = row.querySelector('.subject a');
            const href = subjectLink ? subjectLink.href : '#';
            const trackerAndId = subjectLink ? subjectLink.textContent : ('#' + row.id.replace(/\D/g, ''));

            let statusEl = row.querySelector('.status');
            if (!statusEl || !statusEl.textContent.trim()) {
                statusEl = row.querySelector('.value span');
            }
            const status = statusEl ? statusEl.textContent.trim() : '';
            const s = status.toLowerCase();
            const assignee = row.querySelector('.assigned_to a')?.textContent || '—';
            const isResolved = ['решена', 'выполнена', 'отменена', 'закрыта'].some(k => s.includes(k));
            const unlinkBtn = row.querySelector('.buttons a[data-method="delete"]');

            let relationTag = '';
            let subjectTopic = '';

            if (subjectLink) {
                if (subjectLink.previousSibling && subjectLink.previousSibling.nodeType === 3) {
                    const preText = subjectLink.previousSibling.textContent.trim();
                    for (const rel of KNOWN_RELATIONS) {
                        if (preText.toLowerCase().includes(rel)) { relationTag = rel; break; }
                    }
                } else if (containerId === 'relations') {
                    const cellText = row.querySelector('.subject').textContent.trim();
                    for (const rel of KNOWN_RELATIONS) {
                        if (cellText.toLowerCase().startsWith(rel)) { relationTag = rel; break; }
                    }
                }
                if (subjectLink.nextSibling && subjectLink.nextSibling.nodeType === 3) {
                    subjectTopic = subjectLink.nextSibling.textContent.replace(/^[:\-]\s*/, '').trim();
                }
            }

            const fullSummary = `${trackerAndId} ${subjectTopic}`;

            //тут выделяем таски с релизами в отдельный блок под связанными задачами
            if (containerId === 'relations' && releaseRegex.test(subjectTopic)) {
                hasReleases = true;

                if (!releaseListContainer) {
                    releaseListContainer = document.createElement('div');
                    releaseListContainer.id = releaseBlockId;
                    releaseListContainer.innerHTML = `<p><strong>Релиз</strong></p>`;

                    const innerList = document.createElement('div');
                    innerList.className = 'addon-compact-list';
                    releaseListContainer.appendChild(innerList);
                }

                //в финальной версии заменить вхождение на точное совпадение, пока для отладки так оставил
                let relStatusClass = 'st-step-1';
                if (['уточнение','пауз', 'ожидан', 'отложена'].some(k => s.includes(k))) relStatusClass = 'st-warn';
                else if (['закр', 'отмен', 'не актуально'].some(k => s.includes(k))) relStatusClass = 'st-closed';
                else if (['решена'].some(k => s.includes(k))) relStatusClass = 'st-step-8';
                else if (['релиз', 'ожидает установки', 'выполнена'].some(k => s.includes(k))) relStatusClass = 'st-step-7';
                else if (['протестирована'].some(k => s.includes(k))) relStatusClass = 'st-step-6';
                else if (['ревью', 'review'].some(k => s.includes(k))) relStatusClass = 'st-step-5';
                else if (['тестирование', 'тест'].some(k => s.includes(k))) relStatusClass = 'st-step-4';
                else if (['готова к разраб', 'разработка', 'доработ', 'dev'].some(k => s.includes(k))) relStatusClass = 'st-step-3';
                else if (['в работе', 'работ'].some(k => s.includes(k))) relStatusClass = 'st-step-2';

                const fullSummaryRelease = subjectTopic;

                const relCard = document.createElement('div');
                relCard.className = 'addon-compact-card';
                relCard.style.borderLeft = '4px solid #3b82f6';

                relCard.innerHTML = `
                    <div class="addon-main-info">
                        <a href="${href}" class="addon-summary" title="${fullSummaryRelease}">${fullSummaryRelease}</a>
                    </div>
                    <div class="addon-meta">
                        <span class="addon-user" title="${assignee}">${assignee}</span>
                        <span class="addon-status ${relStatusClass}">${status}</span>
                    </div>
                    ${unlinkBtn ? `<div class="addon-actions"><a href="${unlinkBtn.href}" data-remote="true" data-method="delete" data-confirm="Разорвать связь?" title="Удалить связь">×</a></div>` : ''}
                `;

                relCard.querySelector('.addon-summary').addEventListener('click', (e) => {
                    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                    if (window.self !== window.top) {
                        e.preventDefault();
                        openModal(href, relCard);
                    }
                });

                releaseListContainer.children[1].appendChild(relCard);
                return;
            }

            let tagColorClass = '';
            const relLower = relationTag.toLowerCase().trim();

            if (relLower === 'блокируется') {
                if (!isResolved) {
                    relationTag = 'блокируется задачей';
                    hasBlocker = true;
                    tagColorClass = 'tag-blocking';
                }
            } else if (relLower === 'блокирует') {
                if (!isResolved) {
                    relationTag = 'блокирует задачу';
                    tagColorClass = 'tag-blockiruet';
                }
            }
            if (relationTag.includes('блокируется задачей') && !isResolved) tagColorClass = 'tag-blocking';

            const dueDate = row.querySelector('.due_date')?.textContent || '';
            let dateHtml = '';
            if (dueDate) {
                let badgeClass = 'date-normal';
                if (!isResolved) {
                    const parts = dueDate.split('.');
                    if (parts.length === 3) {
                        const dueObj = new Date(parts[2], parts[1] - 1, parts[0]);
                        const now = new Date(); now.setHours(0, 0, 0, 0);
                        const diffDays = Math.ceil((dueObj - now) / (1000 * 60 * 60 * 24));
                        if (diffDays < 0) badgeClass = 'date-over-filled';
                        else if (diffDays <= 3) badgeClass = 'date-warn-filled';
                    }
                }
                dateHtml = `<span class="addon-date-badge ${badgeClass}" title="Срок завершения">до ${dueDate}</span>`;
            } else {
                dateHtml = `<span class="addon-date-badge date-empty-badge" title="Срок не указан">не задано</span>`;
            }

            let iconHtml = '';
            let cardClass = 'addon-compact-card';
            let statusClass = 'st-step-1';

            //тут тоже меняем на полное соответствие, использовать === а не == (ВАЖНО!!!)
            if (['уточнение','пауз', 'ожидан', 'отложена'].some(k => s.includes(k))) statusClass = 'st-warn';
            else if (['закр', 'отмен', 'не актуально'].some(k => s.includes(k))) statusClass = 'st-closed';
            else if (['решена'].some(k => s.includes(k))) statusClass = 'st-step-8';
            else if (['релиз', 'ожидает установки', 'выполнена'].some(k => s.includes(k))) statusClass = 'st-step-7';
            else if (['протестирована'].some(k => s.includes(k))) statusClass = 'st-step-6';
            else if (['ревью', 'review'].some(k => s.includes(k))) statusClass = 'st-step-5';
            else if (['тестирование', 'тест'].some(k => s.includes(k))) statusClass = 'st-step-4';
            else if (['готова к разраб', 'разработка', 'доработ', 'dev'].some(k => s.includes(k))) statusClass = 'st-step-3';
            else if (['в работе', 'работ'].some(k => s.includes(k))) statusClass = 'st-step-2';

            if ((['уточнение', 'ожидан', 'пауз', 'отложен'].some(k => s.includes(k)))) {
                iconHtml = `<svg class="addon-icon icon-orange" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
            }
            if (['закр', 'отмен', 'не актуально', 'решена', 'выполнена'].some(k => s.includes(k))) {
                cardClass += ' card-dimmed';
            }

            const card = document.createElement('div');
            card.className = cardClass;
            card.innerHTML = `
                <div class="addon-main-info">
                    ${relationTag ? `<span class="addon-relation-tag ${tagColorClass}">${relationTag}</span>` : ''}
                    ${iconHtml}
                    <a href="${href}" class="addon-summary" title="${fullSummary}">${fullSummary}</a>
                </div>
                <div class="addon-meta">
                    <span class="addon-status ${statusClass}">${status}</span>
                    <span class="addon-user" title="${assignee}">${assignee}</span>
                    ${dateHtml}
                </div>
                ${unlinkBtn ? `<div class="addon-actions"><a href="${unlinkBtn.href}" data-remote="true" data-method="delete" data-confirm="Разорвать связь?" title="Удалить связь">×</a></div>` : ''}
            `;

            card.querySelector('.addon-summary').addEventListener('click', (e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                if (window.self !== window.top) {
                    e.preventDefault();
                    openModal(href, card);
                }
            });

            list.appendChild(card);
        });

        table.parentNode.insertBefore(list, table);

        if (releaseListContainer && hasReleases) {
            table.parentNode.insertBefore(releaseListContainer, table);
        }

        if (containerId === 'relations' && hasBlocker) {
            const mainSubjectDiv = document.querySelector('div.subject');
            if (mainSubjectDiv && !mainSubjectDiv.querySelector('.tag-blocking')) {
                const blockerBadge = document.createElement('span');
                blockerBadge.className = 'addon-relation-tag tag-blocking';
                blockerBadge.textContent = 'обнаружен блокер';
                blockerBadge.style.marginRight = '10px';
                mainSubjectDiv.prepend(blockerBadge);
            }
        }
    }

    // =================================================================================
    // ЗАПУСК И СЛЕЖЕНИЕ (нельзя вырезать, иначе не будут обновляться изменения своййств)
    // =================================================================================

    injectMainPageCSS();
    injectTableStyles();

    // =================================================================================
    // ЧАСТЬ 3: КАСТОМНЫЕ ФИЛЬТРЫ
    // =================================================================================





    //функция внедрения кнопок (очищенная, только контейнер)
    // =================================================================================
    // ЧАСТЬ 3: СТРОКА ПОИСКА НА ДОСКЕ
    // =================================================================================

   function applySearchFilter(term) {
    const originalTerm = term.trim();
    term = term.toLowerCase().trim();
    localStorage.setItem('addon_board_search', originalTerm);

    const groups = document.querySelectorAll('.rdb-group');
    const favs = JSON.parse(localStorage.getItem('addon_favorite_tasks') || '[]');

    groups.forEach(group => {
        const issues = group.querySelectorAll('.rdb-issue');
        let visibleCount = 0;

        issues.forEach(card => {
            const idText = card.querySelector('.rdb-menu-link')?.textContent.toLowerCase() || '';
            const subjectText = (card.querySelector('.rdb-property-subject')?.textContent || card.querySelector('.rdb-card-subject')?.textContent || '').toLowerCase();
            const assigneeText = (card.querySelector('.rdb-property-assignee')?.textContent || '').trim();
            const trackerText = (card.querySelector('.rdb-property-tracker')?.textContent || '').trim();
            const statusText = (card.querySelector('.status-border')?.textContent || '').trim();
            const taskId = card.querySelector('.rdb-menu-link')?.textContent.trim().replace('#', '') || '';

            let priorityText = '';
            const prioEl = card.querySelector('.rdb-priority');
            if (prioEl) {
                for (const cls of prioEl.classList) {
                    const configItem = PRIORITIES_CONFIG.find(p => p.id === cls);
                    if (configItem) { priorityText = configItem.label; break; }
                }
            }

            const projEl = card.querySelector('.rdb-card-content > div:not([class])') || card.querySelector('.rdb-card-content > div:nth-child(2)');
            const projectText = projEl ? projEl.textContent.trim() : '';

            let deadlineText = 'Дедлайн не задан';
            if (card.querySelector('.deadline-expired')) deadlineText = 'Дедлайн просрочен';
            else if (card.querySelector('.deadline-warning')) deadlineText = 'Дедлайн скоро';
            else if (card.querySelector('.deadline-normal')) deadlineText = 'Дедлайн не скоро';

            let matchesFilters = true;
            if (activeFilters.users.length > 0 && !activeFilters.users.includes(assigneeText)) matchesFilters = false;
            if (activeFilters.projects.length > 0 && !activeFilters.projects.includes(projectText)) matchesFilters = false;
            if (activeFilters.trackers.length > 0 && !activeFilters.trackers.includes(trackerText)) matchesFilters = false;
            if (activeFilters.statuses.length > 0 && !activeFilters.statuses.includes(statusText)) matchesFilters = false;
            if (activeFilters.priorities.length > 0 && !activeFilters.priorities.includes(priorityText)) matchesFilters = false;
            if (activeFilters.deadlines.length > 0 && !activeFilters.deadlines.includes(deadlineText)) matchesFilters = false;
            if (activeFilters.onlyFavorites && !favs.some(f => f.id === taskId)) matchesFilters = false;

            let matchesSearch = true;
            if (term) matchesSearch = idText.includes(term) || subjectText.includes(term);

            if (matchesFilters && matchesSearch) {
                card.style.display = '';
                visibleCount++;
            } else {
                card.style.display = 'none';
            }
        });

        const hasAnyFilter = term || activeFilters.users.length > 0 || activeFilters.projects.length > 0 || activeFilters.trackers.length > 0 || activeFilters.statuses.length > 0 || activeFilters.priorities.length > 0 || activeFilters.deadlines.length > 0 || activeFilters.onlyFavorites;
        group.style.display = (visibleCount === 0 && hasAnyFilter) ? 'none' : '';
    });

    updateFiltersTriggerBadge();
}

function updateFiltersTriggerBadge() {
    const triggerBtn = document.getElementById('addon-filters-trigger');
    const badge = document.getElementById('addon-filters-badge');
    if (!triggerBtn || !badge) return;

    let count = activeFilters.users.length + activeFilters.projects.length + activeFilters.trackers.length + activeFilters.statuses.length + activeFilters.priorities.length + activeFilters.deadlines.length + (activeFilters.onlyFavorites ? 1 : 0);
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'block';
        triggerBtn.classList.add('active');
    } else {
        badge.style.display = 'none';
        triggerBtn.classList.remove('active');
    }
}






   function getSuggestions(term) {
        const termLower = term.toLowerCase().trim().replace(/ё/g, 'е');
        const termWords = termLower.split(/\s+/).filter(w => w.length > 0);

        const suggestions = [];
        const seenUsers = new Set();
        const seenProjects = new Set();
        const seenTrackers = new Set();
        const seenStatuses = new Set();
        const seenPriorities = new Set();
        const seenDeadlines = new Set();

        // Проверяем, активен ли хотя бы один фильтр прямо сейчас
        const hasAnyActiveFilter = activeFilters.users.length > 0 ||
                                   activeFilters.projects.length > 0 ||
                                   activeFilters.trackers.length > 0 ||
                                   activeFilters.statuses.length > 0 ||
                                   activeFilters.priorities.length > 0 ||
                                   activeFilters.deadlines.length > 0 ||
                                   activeFilters.onlyFavorites;

        // Добавляем макрос "Сбросить все фильтры", если что-то включено
        if (hasAnyActiveFilter) {
            // Реагирует на "сбросить..." или "фильтры...", игнорируя "все"
            const matchReset = "сбросить все фильтры".startsWith(termLower);
            const matchFilters = "фильтры".startsWith(termLower) && termLower !== 'все';

            if (matchReset || matchFilters) {
                suggestions.push({ type: 'reset_all', text: '❌ Сбросить все фильтры', label: '❌ Сбросить все фильтры' });
            }
        }

        if ("избранное".startsWith(termLower) || termLower === '⭐ избранное') {
            suggestions.push({ type: 'filter', text: '⭐ Избранное', label: '⭐ Избранные задачи' });
        }

        document.querySelectorAll('.rdb-issue').forEach(card => {
            const idLink = card.querySelector('.rdb-menu-link');
            const subjectEl = card.querySelector('.rdb-property-subject') || card.querySelector('.rdb-card-subject');
            const subject = subjectEl ? subjectEl.textContent.trim() : 'Без названия';
            const taskId = idLink ? idLink.textContent.trim().replace('#', '') : '';

            const assigneeEl = card.querySelector('.rdb-property-assignee');
            const assignee = assigneeEl ? assigneeEl.textContent.trim() : '';

            const projEl = card.querySelector('.rdb-card-content > div:not([class])') || card.querySelector('.rdb-card-content > div:nth-child(2)');
            const projectText = projEl ? projEl.textContent.trim() : '';

            const trackerEl = card.querySelector('.rdb-property-tracker');
            const tracker = trackerEl ? trackerEl.textContent.trim() : '';

            const statusEl = card.querySelector('.status-border');
            const status = statusEl ? statusEl.textContent.trim() : '';

            let priority = '';
            const prioEl = card.querySelector('.rdb-priority');
            if (prioEl) {
                for (const cls of prioEl.classList) {
                    const configItem = PRIORITIES_CONFIG.find(p => p.id === cls);
                    if (configItem) { priority = configItem.label; break; }
                }
            }

            // 1. Поиск задач
            if ((taskId && taskId.includes(termLower)) || (subject.toLowerCase().replace(/ё/g, 'е').includes(termLower))) {
                suggestions.push({ type: 'task', text: taskId, label: `#${taskId} — ${subject}` });
            }

            // 2. Исполнитель
            if (assignee && !seenUsers.has(assignee)) {
                const nameWords = assignee.toLowerCase().replace(/ё/g, 'е').split(/\s+/);
                const isMatch = termWords.every(searchWord => nameWords.some(nameWord => nameWord.startsWith(searchWord)));
                if (isMatch) {
                    suggestions.push({ type: 'user', text: `👤 ${assignee}`, label: `👤 ${assignee}` });
                    seenUsers.add(assignee);
                }
            }

            // 3. Проект
            if (projectText && !seenProjects.has(projectText)) {
                const projWords = projectText.toLowerCase().replace(/ё/g, 'е').split(/\s+/);
                const isMatch = termWords.every(searchWord => projWords.some(projWord => projWord.startsWith(searchWord)));
                if (isMatch) {
                    suggestions.push({ type: 'project', text: `📁 ${projectText}`, label: `📁 ${projectText}` });
                    seenProjects.add(projectText);
                }
            }

            // 4. Трекер
            if (tracker && !seenTrackers.has(tracker)) {
                if (tracker.toLowerCase().replace(/ё/g, 'е').startsWith(termLower)) {
                    suggestions.push({ type: 'tracker', text: `🏷️ ${tracker}`, label: `🏷️ ${tracker}` });
                    seenTrackers.add(tracker);
                }
            }

            // 5. Статус
            if (status && !seenStatuses.has(status)) {
                if (status.toLowerCase().replace(/ё/g, 'е').startsWith(termLower)) {
                    suggestions.push({ type: 'status', text: `📌 ${status}`, label: `📌 ${status}` });
                    seenStatuses.add(status);
                }
            }

            // 6. Приоритет
            if (priority && !seenPriorities.has(priority)) {
                if (priority.toLowerCase().replace(/ё/g, 'е').startsWith(termLower)) {
                    suggestions.push({ type: 'priority', text: `⚡ ${priority}`, label: `⚡ ${priority}` });
                    seenPriorities.add(priority);
                }
            }

            let deadline = 'Дедлайн не задан';
            if (card.querySelector('.deadline-expired')) deadline = 'Дедлайн просрочен';
            else if (card.querySelector('.deadline-warning')) deadline = 'Дедлайн скоро';
            else if (card.querySelector('.deadline-normal')) deadline = 'Дедлайн не скоро';

            // 7. Дедлайн
            if (deadline && !seenDeadlines.has(deadline)) {
                if (deadline.toLowerCase().replace(/ё/g, 'е').startsWith(termLower)) {
                    suggestions.push({ type: 'deadline', text: `⏰ ${deadline}`, label: `⏰ ${deadline}` });
                    seenDeadlines.add(deadline);
                }
            }
        });

        const uniqueSuggestions = suggestions.filter((v, i, a) => a.findIndex(t => t.label === v.label) === i);

        uniqueSuggestions.sort((a, b) => {
            const filters = ['reset_all', 'user', 'project', 'tracker', 'filter', 'status', 'priority', 'deadline'];
            const isFilterA = filters.includes(a.type) ? 1 : 0;
            const isFilterB = filters.includes(b.type) ? 1 : 0;
            return isFilterB - isFilterA;
        });

        return uniqueSuggestions.slice(0, 5);
    }





   function injectCustomFilters() {
        if (document.getElementById('addon-custom-filters')) {
            applySearchFilter(localStorage.getItem('addon_board_search') || '');
            return;
        }

        const header = document.getElementById('rdb-header');
        if (!header) return;

        const container = document.createElement('div');
        container.id = 'addon-custom-filters';
        container.style.cssText = 'position: relative; float: left; margin-left: 10px; display: flex; align-items: center; gap: 6px;';

        const savedSearch = addonSearchState.value || localStorage.getItem('addon_board_search') || '';

        container.innerHTML = `
            <div class="addon-search-container">
                <input type="text" class="addon-search-input" placeholder="Поиск" value="${savedSearch}">
                <div class="addon-search-clear" style="display: ${savedSearch ? 'flex' : 'none'}">×</div>
                <div class="addon-search-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></div>
            </div>
            <div id="addon-filters-trigger" class="addon-filters-trigger" title="Расширенные фильтры" style="user-select: none;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
                <div id="addon-filters-badge" class="addon-filters-badge" style="display: none;">0</div>
            </div>
            <div id="addon-search-suggestions"></div>
        `;

        const input = container.querySelector('.addon-search-input');
        const clearBtn = container.querySelector('.addon-search-clear');
        const searchBtn = container.querySelector('.addon-search-btn');
        const suggestBox = container.querySelector('#addon-search-suggestions');
        const triggerBtn = container.querySelector('#addon-filters-trigger');

        let activeSuggestionIndex = -1;
        let currentHits = [];

        const renderSuggestionsList = (val) => {
            activeSuggestionIndex = -1;
            suggestBox.innerHTML = '';

            if (!val) {
                suggestBox.style.display = 'none';
                return;
            }

            if (val.length >= 1 || val.startsWith('⭐') || val.startsWith('👤') || val.startsWith('📁') || val.startsWith('🏷️') || val.startsWith('📌') || val.startsWith('⚡') || val.startsWith('⏰')) {
                currentHits = getSuggestions(val);
            } else {
                currentHits = [];
            }

            if (currentHits.length > 0) {
                suggestBox.innerHTML = currentHits.map((h, i) => `<div class="addon-sugg-item" data-index="${i}">${h.label}</div>`).join('');
                suggestBox.style.display = 'block';

                suggestBox.querySelectorAll('.addon-sugg-item').forEach((item) => {
                    item.onmousedown = (e) => e.preventDefault();
                    item.onclick = () => {
                        const hit = currentHits[item.dataset.index];

                        if (hit.type === 'reset_all') {
                            activeFilters.users = []; activeFilters.projects = []; activeFilters.trackers = [];
                            activeFilters.statuses = []; activeFilters.priorities = []; activeFilters.deadlines = [];
                            activeFilters.onlyFavorites = false;
                            input.value = ''; addonSearchState.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'user') {
                            const cleanVal = hit.text.replace('👤', '').trim();
                            if (!activeFilters.users.includes(cleanVal)) activeFilters.users.push(cleanVal);
                            input.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'project') {
                            const cleanVal = hit.text.replace('📁', '').trim();
                            if (!activeFilters.projects.includes(cleanVal)) activeFilters.projects.push(cleanVal);
                            input.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'tracker') {
                            const cleanVal = hit.text.replace('🏷️', '').trim();
                            if (!activeFilters.trackers.includes(cleanVal)) activeFilters.trackers.push(cleanVal);
                            input.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'status') {
                            const cleanVal = hit.text.replace('📌', '').trim();
                            if (!activeFilters.statuses.includes(cleanVal)) activeFilters.statuses.push(cleanVal);
                            input.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'priority') {
                            const cleanVal = hit.text.replace('⚡', '').trim();
                            if (!activeFilters.priorities.includes(cleanVal)) activeFilters.priorities.push(cleanVal);
                            input.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'deadline') {
                            const cleanVal = hit.text.replace('⏰', '').trim();
                            if (!activeFilters.deadlines.includes(cleanVal)) activeFilters.deadlines.push(cleanVal);
                            input.value = ''; clearBtn.style.display = 'none';
                        } else if (hit.type === 'filter' && hit.text.includes('⭐')) {
                            activeFilters.onlyFavorites = true;
                            input.value = ''; clearBtn.style.display = 'none';
                        } else {
                            input.value = hit.text;
                            clearBtn.style.display = 'flex';
                        }

                        executeSearch(false);
                    };
                });
            } else {
                suggestBox.style.display = 'none';
            }
        };

        const executeSearch = (keepFocus = true) => {
            suggestBox.style.display = 'none';
            addonSearchState.value = input.value;
            applySearchFilter(input.value);
            if (!keepFocus) input.blur();
        };

        const updateActiveState = () => {
            const items = suggestBox.querySelectorAll('.addon-sugg-item');
            items.forEach((item, index) => {
                if (index === activeSuggestionIndex) {
                    item.classList.add('addon-sugg-active');
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.classList.remove('addon-sugg-active');
                }
            });
        };

        input.addEventListener('input', (e) => {
            const val = e.target.value;
            addonSearchState.value = val;
            clearBtn.style.display = val ? 'flex' : 'none';
            renderSuggestionsList(val);
            if (!val) applySearchFilter('');
        });

        input.addEventListener('focus', () => {
            addonSearchState.focused = true;
            renderSuggestionsList(input.value);
        });

        input.addEventListener('blur', () => {
            addonSearchState.focused = false;
        });

        input.addEventListener('keydown', (e) => {
            const items = suggestBox.querySelectorAll('.addon-sugg-item');
            const isSuggestOpen = suggestBox.style.display === 'block' && items.length > 0;

            if (e.key === 'ArrowDown') {
                if (isSuggestOpen) { e.preventDefault(); if (activeSuggestionIndex < items.length - 1) { activeSuggestionIndex++; updateActiveState(); } }
            } else if (e.key === 'ArrowUp') {
                if (isSuggestOpen) { e.preventDefault(); if (activeSuggestionIndex > -1) { activeSuggestionIndex--; updateActiveState(); } }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (isSuggestOpen && activeSuggestionIndex > -1 && currentHits[activeSuggestionIndex]) {
                    const hit = currentHits[activeSuggestionIndex];

                    if (hit.type === 'reset_all') {
                        activeFilters.users = []; activeFilters.projects = []; activeFilters.trackers = [];
                        activeFilters.statuses = []; activeFilters.priorities = []; activeFilters.deadlines = [];
                        activeFilters.onlyFavorites = false;
                        input.value = ''; addonSearchState.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'user') {
                        const cleanVal = hit.text.replace('👤', '').trim();
                        if (!activeFilters.users.includes(cleanVal)) activeFilters.users.push(cleanVal);
                        input.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'project') {
                        const cleanVal = hit.text.replace('📁', '').trim();
                        if (!activeFilters.projects.includes(cleanVal)) activeFilters.projects.push(cleanVal);
                        input.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'tracker') {
                        const cleanVal = hit.text.replace('🏷️', '').trim();
                        if (!activeFilters.trackers.includes(cleanVal)) activeFilters.trackers.push(cleanVal);
                        input.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'status') {
                        const cleanVal = hit.text.replace('📌', '').trim();
                        if (!activeFilters.statuses.includes(cleanVal)) activeFilters.statuses.push(cleanVal);
                        input.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'priority') {
                        const cleanVal = hit.text.replace('⚡', '').trim();
                        if (!activeFilters.priorities.includes(cleanVal)) activeFilters.priorities.push(cleanVal);
                        input.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'deadline') {
                        const cleanVal = hit.text.replace('⏰', '').trim();
                        if (!activeFilters.deadlines.includes(cleanVal)) activeFilters.deadlines.push(cleanVal);
                        input.value = ''; clearBtn.style.display = 'none';
                    } else if (hit.type === 'filter' && hit.text.includes('⭐')) {
                        activeFilters.onlyFavorites = true;
                        input.value = ''; clearBtn.style.display = 'none';
                    } else {
                        input.value = hit.text;
                        clearBtn.style.display = 'flex';
                    }
                    executeSearch(true);
                } else {
                    executeSearch(true);
                }
            }
        });

        document.addEventListener('click', (e) => { if (!container.contains(e.target)) suggestBox.style.display = 'none'; });
        searchBtn.onclick = () => executeSearch(false);
        clearBtn.onclick = () => { input.value = ''; addonSearchState.value = ''; clearBtn.style.display = 'none'; suggestBox.style.display = 'none'; applySearchFilter(''); input.focus(); };

        initFiltersDropdownLogic(container, triggerBtn);

        const boardElement = header.querySelector('.rdb-filter.rdb-async') || header.querySelector('.rdb-filter');
        header.insertBefore(container, boardElement || header.firstChild);

        updateFiltersTriggerBadge();

        if (addonSearchState.focused) {
            setTimeout(() => {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                renderSuggestionsList(input.value);
            }, 10);
        }
    }







    function initFiltersDropdownLogic(parentContainer, triggerBtn) {
        // Достаем сохраненную ширину или ставим дефолтную
        const savedWidth = localStorage.getItem('addon_filters_width') || '260px';

        const dropdown = document.createElement('div');
        dropdown.id = 'addon-filters-dropdown';
        Object.assign(dropdown.style, {
            position: 'absolute', top: '100%', left: '208px', marginTop: '8px',
            backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)', padding: '12px',
            minWidth: '260px',
            width: savedWidth, // Применяем ширину
            zIndex: '1000', display: 'none', flexDirection: 'column', gap: '2px', boxSizing: 'border-box',
            resize: 'horizontal', // Включаем растягивание по горизонтали
            overflow: 'hidden'    // Обязательное условие для работы resize
        });

        parentContainer.appendChild(dropdown);

        // Отслеживаем растягивание окна и сохраняем размер в local storage
        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                if (dropdown.style.display !== 'none' && dropdown.style.width) {
                    localStorage.setItem('addon_filters_width', dropdown.style.width);
                }
            }
        });
        resizeObserver.observe(dropdown);

        dropdown.addEventListener('click', (e) => e.stopPropagation());

        triggerBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const isOpen = dropdown.style.display === 'flex';

            document.querySelectorAll('#addon-assignee-dropdown, #addon-settings-dropdown').forEach(el => el.style.display = 'none');

            if (isOpen) {
                dropdown.style.display = 'none';
            } else {
                window.renderFiltersDropdownView('main');
                dropdown.style.display = 'flex';
            }
        });

        document.addEventListener('click', (e) => {
            if (e.composedPath().includes(dropdown)) return;
            if (!parentContainer.contains(e.target) && dropdown.style.display === 'flex') dropdown.style.display = 'none';
        });

        window.toggleDropdownCheckboxFilter = function(type, val) {
            if (type === 'users') {
                if (activeFilters.users.includes(val)) activeFilters.users = activeFilters.users.filter(x => x !== val);
                else activeFilters.users.push(val);
            } else if (type === 'projects') {
                if (activeFilters.projects.includes(val)) activeFilters.projects = activeFilters.projects.filter(x => x !== val);
                else activeFilters.projects.push(val);
            } else if (type === 'trackers') {
                if (activeFilters.trackers.includes(val)) activeFilters.trackers = activeFilters.trackers.filter(x => x !== val);
                else activeFilters.trackers.push(val);
            } else if (type === 'statuses') {
                if (activeFilters.statuses.includes(val)) activeFilters.statuses = activeFilters.statuses.filter(x => x !== val);
                else activeFilters.statuses.push(val);
            } else if (type === 'priorities') {
                if (activeFilters.priorities.includes(val)) activeFilters.priorities = activeFilters.priorities.filter(x => x !== val);
                else activeFilters.priorities.push(val);
            } else if (type === 'deadlines') {
                if (activeFilters.deadlines.includes(val)) activeFilters.deadlines = activeFilters.deadlines.filter(x => x !== val);
                else activeFilters.deadlines.push(val);
            }
            applySearchFilter(document.querySelector('.addon-search-input')?.value || '');
            window.renderFiltersDropdownView(window.currentDropdownView);
        };

        window.toggleFavoritesDropdownFilter = function() {
            activeFilters.onlyFavorites = !activeFilters.onlyFavorites;
            applySearchFilter(document.querySelector('.addon-search-input')?.value || '');
            window.renderFiltersDropdownView('main');
        };

        window.renderFiltersDropdownView = function(view) {
            window.currentDropdownView = view;
            const boardData = getAvailableBoardData();
            dropdown.innerHTML = '';

            const hasAnyFilter = activeFilters.users.length > 0 || activeFilters.projects.length > 0 || activeFilters.trackers.length > 0 || activeFilters.statuses.length > 0 || activeFilters.priorities.length > 0 || activeFilters.deadlines.length > 0 || activeFilters.onlyFavorites;

            const renderTags = () => {
                if (!hasAnyFilter) return '';
                let html = '<div class="addon-filter-tags-container" style="padding: 6px 0 2px 0;">';
                activeFilters.users.forEach(u => html += `<div class="addon-filter-tag" title="${u}">👤 ${u.split(' ')[0]} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('users', '${u}')">×</span></div>`);
                activeFilters.projects.forEach(p => html += `<div class="addon-filter-tag" title="${p}">📁 ${p} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('projects', '${p}')">×</span></div>`);
                activeFilters.trackers.forEach(t => html += `<div class="addon-filter-tag" title="${t}">🏷️ ${t} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('trackers', '${t}')">×</span></div>`);
                activeFilters.statuses.forEach(s => html += `<div class="addon-filter-tag" title="${s}">📌 ${s} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('statuses', '${s}')">×</span></div>`);
                activeFilters.priorities.forEach(p => html += `<div class="addon-filter-tag" title="${p}">⚡ ${p} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('priorities', '${p}')">×</span></div>`);
                activeFilters.deadlines.forEach(d => html += `<div class="addon-filter-tag" title="${d}">⏰ ${d} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('deadlines', '${d}')">×</span></div>`);
                if (activeFilters.onlyFavorites) html += `<div class="addon-filter-tag">⭐ Избр. <span class="addon-filter-tag-close" onclick="event.stopPropagation(); window.removeActiveSearchTag('fav', '')">×</span></div>`;
                html += '</div>';
                return html;
            };

            if (view === 'main') {
                dropdown.innerHTML = `
                    <div class="addon-filters-header">Фильтрация карточек</div>

                    <div class="addon-filter-link-row" onclick="window.renderFiltersDropdownView('users')">
                        <span style="display:flex; flex-direction:column;"><label style="font-weight:500; cursor:pointer;">Исполнители</label><span style="font-size:11px; color:#94a3b8;">Выбрано: ${activeFilters.users.length}</span></span><span style="color:#cbd5e1; font-size:11px;">➔</span>
                    </div>
                    <div class="addon-filter-link-row" onclick="window.renderFiltersDropdownView('projects')">
                        <span style="display:flex; flex-direction:column;"><label style="font-weight:500; cursor:pointer;">Проекты</label><span style="font-size:11px; color:#94a3b8;">Выбрано: ${activeFilters.projects.length}</span></span><span style="color:#cbd5e1; font-size:11px;">➔</span>
                    </div>
                    <div class="addon-filter-link-row" onclick="window.renderFiltersDropdownView('trackers')">
                        <span style="display:flex; flex-direction:column;"><label style="font-weight:500; cursor:pointer;">Трекеры</label><span style="font-size:11px; color:#94a3b8;">Выбрано: ${activeFilters.trackers.length}</span></span><span style="color:#cbd5e1; font-size:11px;">➔</span>
                    </div>
                    <div class="addon-filter-link-row" onclick="window.renderFiltersDropdownView('statuses')">
                        <span style="display:flex; flex-direction:column;"><label style="font-weight:500; cursor:pointer;">Статусы</label><span style="font-size:11px; color:#94a3b8;">Выбрано: ${activeFilters.statuses.length}</span></span><span style="color:#cbd5e1; font-size:11px;">➔</span>
                    </div>
                    <div class="addon-filter-link-row" onclick="window.renderFiltersDropdownView('priorities')">
                        <span style="display:flex; flex-direction:column;"><label style="font-weight:500; cursor:pointer;">Приоритеты</label><span style="font-size:11px; color:#94a3b8;">Выбрано: ${activeFilters.priorities.length}</span></span><span style="color:#cbd5e1; font-size:11px;">➔</span>
                    </div>
                    <div class="addon-filter-link-row" onclick="window.renderFiltersDropdownView('deadlines')">
                        <span style="display:flex; flex-direction:column;"><label style="font-weight:500; cursor:pointer;">Дедлайны</label><span style="font-size:11px; color:#94a3b8;">Выбрано: ${activeFilters.deadlines.length}</span></span><span style="color:#cbd5e1; font-size:11px;">➔</span>
                    </div>

                    <div class="addon-filters-divider"></div>

                    <div class="addon-filter-link-row" onclick="window.toggleFavoritesDropdownFilter()">
                        <label style="font-weight:500; cursor:pointer;">Только избранные</label><input type="checkbox" ${activeFilters.onlyFavorites ? 'checked' : ''} style="pointer-events:none;">
                    </div>

                    ${hasAnyFilter ? `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e2e8f0;">${renderTags()}</div>` : ''}

                    ${hasAnyFilter ? `<div id="addon-filters-btn-reset-all" style="margin-top:4px; padding-top:8px; border-top:1px solid #e2e8f0; font-size:12px; font-weight:600; color:#ef4444; text-align:center; cursor:pointer; transition: opacity 0.2s;">Сбросить все фильтры</div>` : ''}
                `;

                const resetBtn = dropdown.querySelector('#addon-filters-btn-reset-all');
                if (resetBtn) {
                    resetBtn.onmouseenter = () => resetBtn.style.opacity = '0.7'; resetBtn.onmouseleave = () => resetBtn.style.opacity = '1';
                    resetBtn.onclick = () => {
                        activeFilters.users = []; activeFilters.projects = []; activeFilters.trackers = []; activeFilters.statuses = []; activeFilters.priorities = []; activeFilters.deadlines = []; activeFilters.onlyFavorites = false;
                        applySearchFilter(document.querySelector('.addon-search-input')?.value || ''); renderFiltersDropdownView('main');
                    };
                }
            } else {
                let headerText = '', arrData = [], activeArr = [], prefix = '', actionType = '';

                if (view === 'users') { headerText = 'Сбросить исполнителей'; arrData = boardData.users; activeArr = activeFilters.users; prefix = '👤 '; actionType = 'users'; }
                if (view === 'projects') { headerText = 'Сбросить проекты'; arrData = boardData.projects; activeArr = activeFilters.projects; prefix = '📁 '; actionType = 'projects'; }
                if (view === 'trackers') { headerText = 'Сбросить трекеры'; arrData = boardData.trackers; activeArr = activeFilters.trackers; prefix = '🏷️ '; actionType = 'trackers'; }
                if (view === 'statuses') { headerText = 'Сбросить статусы'; arrData = boardData.statuses; activeArr = activeFilters.statuses; prefix = '📌 '; actionType = 'statuses'; }
                if (view === 'priorities') { headerText = 'Сбросить приоритеты'; arrData = boardData.priorities; activeArr = activeFilters.priorities; prefix = '⚡ '; actionType = 'priorities'; }
                if (view === 'deadlines') { headerText = 'Сбросить дедлайны'; arrData = boardData.deadlines; activeArr = activeFilters.deadlines; prefix = '⏰ '; actionType = 'deadlines'; }

                // Динамический стиль для лейблов: для проектов разрешаем перенос слов
                const labelStyle = actionType === 'projects'
                    ? 'cursor:pointer; flex: 1; white-space:normal; word-wrap:break-word; margin-right:8px; line-height:1.4;'
                    : 'cursor:pointer; flex: 1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:8px;';

                dropdown.innerHTML = `
                    <div class="addon-filter-link-row" style="padding-left:4px !important; margin-bottom:4px;" onclick="window.renderFiltersDropdownView('main')">
                        <span style="font-weight:600; color:#2563eb; display:flex; align-items:center; gap:4px;"><span style="font-size:10px;">◀</span> Назад</span>
                    </div>
                    <div class="addon-filters-header">Доступные на доске</div>
                    <div style="display:flex; flex-direction:column; gap:2px; max-height:220px; overflow-y:auto; padding-right:2px;">
                        ${arrData.map(val => `
                            <div class="addon-filter-link-row" onclick="window.toggleDropdownCheckboxFilter('${actionType}', '${val}')">
                                <label style="${labelStyle}">${prefix}${val}</label>
                                <input type="checkbox" ${activeArr.includes(val) ? 'checked' : ''} style="pointer-events:none; flex-shrink: 0;">
                            </div>
                        `).join('')}
                        ${arrData.length === 0 ? '<div style="font-size:12px; color:#94a3b8; text-align:center; padding:10px;">Нет данных</div>' : ''}
                    </div>

                    ${hasAnyFilter ? `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e2e8f0;">${renderTags()}</div>` : ''}

                    ${activeArr.length > 0 ? `<div id="addon-filters-btn-reset-cat" style="margin-top:4px; padding-top:8px; border-top:1px solid #e2e8f0; font-size:12px; font-weight:600; color:#ef4444; text-align:center; cursor:pointer; transition: opacity 0.2s;">${headerText}</div>` : ''}
                `;

                const resetCatBtn = dropdown.querySelector('#addon-filters-btn-reset-cat');
                if (resetCatBtn) {
                    resetCatBtn.onmouseenter = () => resetCatBtn.style.opacity = '0.7'; resetCatBtn.onmouseleave = () => resetCatBtn.style.opacity = '1';
                    resetCatBtn.onclick = () => {
                        activeFilters[actionType] = [];
                        applySearchFilter(document.querySelector('.addon-search-input')?.value || ''); window.renderFiltersDropdownView(view);
                    };
                }
            }
        };
    }








    // Динамический сбор уникальных сущностей на текущей доске
function getAvailableBoardData() {
    const users = new Set();
    const projects = new Set();
    const trackers = new Set();
    const statuses = new Set();
    const priorities = new Set();
    const deadlines = new Set();

    document.querySelectorAll('.rdb-issue').forEach(card => {
        const u = card.querySelector('.rdb-property-assignee')?.textContent.trim();
        if (u) users.add(u);

        const projEl = card.querySelector('.rdb-card-content > div:not([class])') || card.querySelector('.rdb-card-content > div:nth-child(2)');
        const p = projEl ? projEl.textContent.trim() : '';
        if (p && !p.includes('Deadline:') && !p.includes('до ')) projects.add(p);

        const t = card.querySelector('.rdb-property-tracker')?.textContent.trim();
        if (t) trackers.add(t);

        const s = card.querySelector('.status-border')?.textContent.trim();
        if (s) statuses.add(s);

        const prioEl = card.querySelector('.rdb-priority');
        if (prioEl) {
            for (const cls of prioEl.classList) {
                const configItem = PRIORITIES_CONFIG.find(p => p.id === cls);
                if (configItem) { priorities.add(configItem.label); break; }
            }
        }

        if (card.querySelector('.deadline-expired')) deadlines.add('Дедлайн просрочен');
        else if (card.querySelector('.deadline-warning')) deadlines.add('Дедлайн скоро');
        else if (card.querySelector('.deadline-normal')) deadlines.add('Дедлайн не скоро');
        else deadlines.add('Дедлайн не задан');
    });

    return {
        users: Array.from(users).sort(),
        projects: Array.from(projects).sort(),
        trackers: Array.from(trackers).sort(),
        statuses: Array.from(statuses).sort(),
        deadlines: Array.from(deadlines).sort(),
        // Сортируем приоритеты по весу из конфига
        priorities: Array.from(priorities).sort((a, b) => {
            const weightA = PRIORITIES_CONFIG.find(p => p.label === a)?.weight || 0;
            const weightB = PRIORITIES_CONFIG.find(p => p.label === b)?.weight || 0;
            return weightB - weightA;
        })
    };
}





function openFiltersModal() {
    let overlay = document.getElementById('addon-filter-modal-overlay');
    let modal = document.getElementById('addon-filter-modal');

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'addon-filter-modal-overlay';
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.4); z-index: 10007; backdrop-filter: blur(3px); opacity: 0; transition: opacity 0.2s;';
        document.body.appendChild(overlay);

        modal = document.createElement('div');
        modal.id = 'addon-filter-modal';
        modal.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95); background: #fff; width: 460px; max-height: 85vh; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); z-index: 10008; font-family: \'Inter\', sans-serif; display: flex; flex-direction: column; opacity: 0; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); overflow: hidden;';
        document.body.appendChild(modal);

        overlay.addEventListener('click', closeFiltersModal);
    }

    function closeFiltersModal() {
        overlay.style.opacity = '0';
        modal.style.opacity = '0';
        modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
        setTimeout(() => { overlay.style.display = 'none'; modal.style.display = 'none'; }, 200);
    }

    // Внутренний роутинг окон: 'main' | 'users' | 'trackers'
    window.renderFiltersView = function(view) {
        const boardData = getAvailableBoardData();

        // Кнопка закрытия
        const closeIconSvg = `<svg id="addon-filter-close-icon" style="cursor: pointer; color: #64748b; transition: color 0.2s;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        const backIconSvg = `<svg id="addon-filter-back-icon" style="cursor: pointer; color: #64748b; transition: color 0.2s; margin-right: 8px;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`;

        // Хелпер генерации тегов-блоков с крестиком
        const renderTags = () => {
            let html = '<div class="addon-filter-tags-container">';
            activeFilters.users.forEach(u => {
                html += `<div class="addon-filter-tag">👤 ${u} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); removeFilterNode('users', '${u}')">×</span></div>`;
            });
            activeFilters.trackers.forEach(t => {
                html += `<div class="addon-filter-tag">🏷️ ${t} <span class="addon-filter-tag-close" onclick="event.stopPropagation(); removeFilterNode('trackers', '${t}')">×</span></div>`;
            });
            if (activeFilters.onlyFavorites) {
                html += `<div class="addon-filter-tag">⭐ Избранное <span class="addon-filter-tag-close" onclick="event.stopPropagation(); removeFilterNode('fav', '')">×</span></div>`;
            }
            html += '</div>';
            return html;
        };

        window.removeFilterNode = function(type, val) {
            if (type === 'users') activeFilters.users = activeFilters.users.filter(x => x !== val);
            if (type === 'trackers') activeFilters.trackers = activeFilters.trackers.filter(x => x !== val);
            if (type === 'fav') activeFilters.onlyFavorites = false;

            // Моментальное применение изменений на доске
            const currentSearchInput = document.querySelector('.addon-search-input');
            applySearchFilter(currentSearchInput ? currentSearchInput.value : '');

            // Мягкий ререндер текущего представления в модалке
            renderFiltersView(view);
        };

        window.toggleCheckboxFilter = function(type, val) {
            if (type === 'users') {
                if (activeFilters.users.includes(val)) activeFilters.users = activeFilters.users.filter(x => x !== val);
                else activeFilters.users.push(val);
            } else if (type === 'trackers') {
                if (activeFilters.trackers.includes(val)) activeFilters.trackers.push(val);
                else activeFilters.trackers.push(val);
            }

            const currentSearchInput = document.querySelector('.addon-search-input');
            applySearchFilter(currentSearchInput ? currentSearchInput.value : '');
            renderFiltersView(view);
        };

        if (view === 'main') {
            // --- ГЛАВНЫЙ ЭКРАН ФИЛЬТРОВ ---
            modal.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
                    <h3 style="margin:0; font-size:16px; font-weight:600; color:#0f172a;">Фильтры доски</h3>
                    ${closeIconSvg}
                </div>
                <div style="padding: 20px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto;">
                    ${renderTags()}

                    <div class="addon-filter-item-row" onclick="renderFiltersView('users')">
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <span style="font-weight:600; font-size:13px; color:#334155;">Исполнитель</span>
                            <span style="font-size:11px; color:#64748b;">Выбрано: ${activeFilters.users.length}</span>
                        </div>
                        <span style="color:#94a3b8;">➔</span>
                    </div>

                    <div class="addon-filter-item-row" onclick="renderFiltersView('trackers')">
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <span style="font-weight:600; font-size:13px; color:#334155;">Трекер</span>
                            <span style="font-size:11px; color:#64748b;">Выбрано: ${activeFilters.trackers.length}</span>
                        </div>
                        <span style="color:#94a3b8;">➔</span>
                    </div>

                    <div class="addon-filter-item-row" onclick="event.stopPropagation(); activeFilters.onlyFavorites = !activeFilters.onlyFavorites; applySearchFilter(document.querySelector('.addon-search-input')?.value || ''); renderFiltersView('main');">
                        <span style="font-weight:600; font-size:13px; color:#334155;">Показать только избранные</span>
                        <input type="checkbox" ${activeFilters.onlyFavorites ? 'checked' : ''} style="cursor:pointer; pointer-events:none;">
                    </div>
                </div>
                <div style="padding: 12px 20px; border-top:1px solid #e2e8f0; background:#f8fafc; display:flex; justify-content:flex-end; gap:8px;">
                    <button id="addon-filters-reset-all" style="padding:6px 14px; font-size:13px; font-weight:600; border-radius:6px; border:1px solid #cbd5e1; background:#fff; color:#64748b; cursor:pointer;">Сбросить всё</button>
                    <button id="addon-filters-apply-close" style="padding:6px 14px; font-size:13px; font-weight:600; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer;">Готово</button>
                </div>
            `;

            modal.querySelector('#addon-filters-reset-all').onclick = () => {
                activeFilters.users = [];
                activeFilters.trackers = [];
                activeFilters.onlyFavorites = false;
                applySearchFilter(document.querySelector('.addon-search-input')?.value || '');
                renderFiltersView('main');
            };
            modal.querySelector('#addon-filters-apply-close').onclick = closeFiltersModal;

        } else if (view === 'users') {
            // --- ЭКРАН МНОЖЕСТВЕННОГО ВЫБОРА ИСПОЛНИТЕЛЕЙ ---
            modal.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
                    <div style="display:flex; align-items:center;">${backIconSvg}<h3 style="margin:0; font-size:16px; font-weight:600; color:#0f172a;">Выбор исполнителей</h3></div>
                    ${closeIconSvg}
                </div>
                <div style="padding: 20px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;">
                    ${renderTags()}
                    <div style="display:flex; flex-direction:column; gap:4px; max-height:300px; overflow-y:auto; padding-right:4px;">
                        ${boardData.users.map(u => `
                            <label style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; cursor:pointer; font-size:13px; margin:0;" onclick="event.preventDefault(); toggleCheckboxFilter('users', '${u}')">
                                <span>👤 ${u}</span>
                                <input type="checkbox" ${activeFilters.users.includes(u) ? 'checked' : ''} style="pointer-events:none;">
                            </label>
                        `).join('')}
                    </div>
                </div>
            `;
            modal.querySelector('#addon-filter-back-icon').onclick = () => renderFiltersView('main');

        } else if (view === 'trackers') {
            // --- ЭКРАН МНОЖЕСТВЕННОГО ВЫБОРА ТРЕКЕРОВ ---
            modal.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
                    <div style="display:flex; align-items:center;">${backIconSvg}<h3 style="margin:0; font-size:16px; font-weight:600; color:#0f172a;">Выбор трекеров</h3></div>
                    ${closeIconSvg}
                </div>
                <div style="padding: 20px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;">
                    ${renderTags()}
                    <div style="display:flex; flex-direction:column; gap:4px; max-height:300px; overflow-y:auto; padding-right:4px;">
                        ${boardData.trackers.map(t => `
                            <label style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; cursor:pointer; font-size:13px; margin:0;" onclick="event.preventDefault(); toggleCheckboxFilter('trackers', '${t}')">
                                <span>🏷️ ${t}</span>
                                <input type="checkbox" ${activeFilters.trackers.includes(t) ? 'checked' : ''} style="pointer-events:none;">
                            </label>
                        `).join('')}
                    </div>
                </div>
            `;
            modal.querySelector('#addon-filter-back-icon').onclick = () => renderFiltersView('main');
        }

        // Привязка общих управляющих кнопок закрытия окон
        const closeIcon = modal.querySelector('#addon-filter-close-icon');
        if (closeIcon) closeIcon.onclick = closeFiltersModal;
    };

    renderFiltersView('main');

    overlay.style.display = 'block';
    modal.style.display = 'flex';
    setTimeout(() => { overlay.style.opacity = '1'; modal.style.opacity = '1'; modal.style.transform = 'translate(-50%, -50%) scale(1)'; }, 10);
}




    //добавление кнопки создания задачи, см. метод по созданию фильтров, чтобы понять логику инжектмрования
    function injectCreateButton() {
        if (document.getElementById('addon-create-btn')) return;

        //ищем наш контейнер с кнопками фильтров
        const filterContainer = document.getElementById('addon-custom-filters');
        // Если контейнера фильтров нет (скрипт еще не отработал?), выходим, сработает в следующем цикле observer
        if (!filterContainer) return;

        //парсим текущий URL проекта
        const projectMatch = window.location.pathname.match(/\/projects\/([^\/]+)/);
        if (!projectMatch) return;

        const projectName = projectMatch[1];
        const createUrl = `/projects/${projectName}/issues/new`;

        //создаем кнопку
        const btn = document.createElement('div');
        btn.id = 'addon-create-btn';
        btn.className = 'addon-create-btn'; //см файл стайлуса с css, стили оттуда тянутся
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Создать задачу
        `;

        //лбработчик клика
        btn.onclick = () => {
            openModal(createUrl, null, true);
        };

        //чтобы кнопка была левее фильтров. Если надо сделать правее - закомментить строку ниже.
        filterContainer.prepend(btn);
    }

    //ЭТО БОЛЬШЕ НЕ НУЖНО, МОЖНО УДАЛИТЬ ФУНКЦИЮ. эТОТ ПАРАМЕТР ПЕРЕНЕС В НАСТРОЙКИ, ТАМ БУДУТ ОТДЕЛЬНЫЕ МЕТОДЫ, ЭТО ОСТАВИЛ ПОКА НЕ ПРОТЕСТИЛ НОВУЮ РЕАЛИЗАЦИЮ.
    function injectAutoRefreshToggle() {
        if (document.getElementById('addon-autorefresh-toggle')) return;

        const filterContainer = document.getElementById('addon-custom-filters');
        if (!filterContainer) return;

        //читаем состояние из localStorage (по умолчанию false/null)
        //используем true как строку, т.к. localStorage хранит строки
        let isAutoRefreshActive = localStorage.getItem('addon_autorefresh') === 'true';

        // создаем кнопку
        const btn = document.createElement('div');
        btn.id = 'addon-autorefresh-toggle';
        btn.className = 'addon-toggle-btn';
        //Добавляем класс active, если сохранено включенное состояние
        if (isAutoRefreshActive) btn.classList.add('active');

        btn.title = 'Если включено: список задач обновится автоматически после закрытия окна просмотра.\nЭто удобно для поддержания доски в актуальном состоянии';

        btn.innerHTML = `
            <svg class="addon-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span>Рефрешер</span>
        `;

        //обработчик клика
        btn.onclick = () => {
            isAutoRefreshActive = !isAutoRefreshActive;

            //схраняем новое состояние
            localStorage.setItem('addon_autorefresh', isAutoRefreshActive);

            //меням визуал
            btn.classList.toggle('active', isAutoRefreshActive);
        };

        //вставляем правее фильтров. Закомментить, если не нужно.
        filterContainer.appendChild(btn);
    }

    //смена фона и насттройки фона
    function applyCustomBackground() {
        const bgData = localStorage.getItem('addon_background');
        // берем сохраненную прозрачность (дефолт 0.3)
        const bgOpacity = localStorage.getItem('addon_bg_opacity') || '0.3';
        //берем тип отображения фона (фиксед или скрол)
        const bgAttachment = localStorage.getItem('addon_bg_attachment') || 'fixed';

        let style = document.getElementById('addon-custom-bg-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'addon-custom-bg-style';
            document.head.appendChild(style);
        }

        if (bgData) {
            //определяет фиксируем мы фон или растягиваем под всю длину карточек, данамичпескя штука
            style.textContent = `#rdb-board::before { background-image: url('${bgData}') !important; opacity: ${bgOpacity} !important; background-attachment: ${bgAttachment} !important; }`;
        } else {
            style.textContent = `#rdb-board::before { background-image: none !important; opacity: ${bgOpacity} !important; background-attachment: ${bgAttachment} !important; }`;
        }
    }

    //Больше не используется, можно удалить. Этот параметр будет перенесен в настройки, пока оставляю метод, чтобы можно было откатиться. Если настройки работают корректно - можно смело удалять метод из кода
    function injectBackgroundMenu() {
        if (document.getElementById('addon-bg-menu-container')) return;

        const filterContainer = document.getElementById('addon-custom-filters');
        if (!filterContainer) return;

        //контейнер для кнопки и выпадающего меню (для позиционирования)
        const container = document.createElement('div');
        container.id = 'addon-bg-menu-container';
        container.style.position = 'relative';
        container.style.marginLeft = '8px';

        //скрытый инпут для файла
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        container.appendChild(fileInput);

        //Сама кнопка
        const btn = document.createElement('div');
        btn.className = 'addon-toggle-btn';
        btn.style.marginLeft = '0'; //убираем отступ, т.к. он задан на контейнере, ьещ этой фичи кнопка разбухает шо пздц
        btn.title = 'Настройки фона доски';
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <span>Фон</span>
        `;
        container.appendChild(btn);

        //получаем текущую прозрачность для ползунка
        const currentOpacity = localStorage.getItem('addon_bg_opacity') || '0.3';
        //тут извлекаем из локал стораджа текущее значение фона - зафиксирован он или нет
        const currentAttachment = localStorage.getItem('addon_bg_attachment') || 'fixed';
        const isFixed = currentAttachment === 'fixed';

        // выпадающее меню
        const dropdown = document.createElement('div');
        Object.assign(dropdown.style, {
            position: 'absolute',
            top: '100%',
            right: '0',
            marginTop: '8px',
            backgroundColor: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
            padding: '8px',
            minWidth: '200px',
            zIndex: '1000',
            display: 'none', //скрыто по умолчанию
            flexDirection: 'column',
            gap: '4px',
            fontFamily: "'Inter', sans-serif"
        });

        //блок с чекбоксом
        dropdown.innerHTML = `
            <div id="addon-bg-upload" style="padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; font-weight: 500; color: #334155; transition: background 0.2s;">Загрузить картинку</div>
            <div id="addon-bg-reset" style="padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; font-weight: 500; color: #dc2626; transition: background 0.2s;">Сбросить фон</div>
            <div style="height: 1px; background: #e2e8f0; margin: 4px 0;"></div>
            <div style="padding: 4px 12px;">
                <div style="font-size: 12px; font-weight: 500; color: #64748b; margin-bottom: 6px; display: flex; justify-content: space-between;">
                    <span>Непрозрачность</span>
                    <span id="addon-opacity-val">${Math.round(currentOpacity * 100)}%</span>
                </div>
                <input type="range" id="addon-opacity-slider" min="0" max="1" step="0.05" value="${currentOpacity}" style="width: 100%; cursor: pointer;">
            </div>
            <div style="padding: 4px 12px 8px 12px; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 500; color: #64748b;">Зафиксировать фон</span>
                <label style="position: relative; display: inline-block; width: 32px; height: 18px; margin: 0;">
                    <input type="checkbox" id="addon-attachment-toggle" style="opacity: 0; width: 0; height: 0;" ${isFixed ? 'checked' : ''}>
                    <span id="addon-attachment-slider" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${isFixed ? '#3b82f6' : '#cbd5e1'}; transition: .2s; border-radius: 18px;">
                        <span id="addon-attachment-knob" style="position: absolute; content: ''; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: .2s; border-radius: 50%; transform: ${isFixed ? 'translateX(14px)' : 'translateX(0)'};"></span>
                    </span>
                </label>
            </div>
        `;
        container.appendChild(dropdown);
        filterContainer.appendChild(container);

        // Ховер эффекты для пунктов меню
        ['addon-bg-upload', 'addon-bg-reset'].forEach(id => {
            const el = dropdown.querySelector('#' + id);
            el.onmouseenter = () => el.style.backgroundColor = '#f1f5f9';
            el.onmouseleave = () => el.style.backgroundColor = 'transparent';
        });

        // логика открытия и закрытия менюшки по клику на кнопку
        btn.onclick = (e) => {
            e.stopPropagation();
            dropdown.style.display = dropdown.style.display === 'flex' ? 'none' : 'flex';
        };

        // закрытие меню при клике в любое место экрана
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });

        // логика загрузки
        dropdown.querySelector('#addon-bg-upload').onclick = () => {
            dropdown.style.display = 'none';
            fileInput.click();
        };

        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file || !file.type.startsWith('image/')) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    const MAX_WIDTH = 1920;
                    const MAX_HEIGHT = 1080;
                    let width = img.width;
                    let height = img.height;

                    if (width > height) {
                        if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                    } else {
                        if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                    }

                    canvas.width = width;
                    canvas.height = height;
                    ctx.drawImage(img, 0, 0, width, height);

                    const base64String = canvas.toDataURL('image/jpeg', 0.8);
                    try {
                        localStorage.setItem('addon_background', base64String);
                        applyCustomBackground();
                    } catch (err) {
                        alert('Критическая ошибка: файл слишком большой. Попробуйте картинку меньшего размера.');
                    }
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
            fileInput.value = ''; // сброс инпута
        };

        // сброс пикчи
        dropdown.querySelector('#addon-bg-reset').onclick = () => {
            dropdown.style.display = 'none';
            localStorage.removeItem('addon_background');
            applyCustomBackground();
        };

        // ползунок прозрачности (сразу применяем)
        const opacitySlider = dropdown.querySelector('#addon-opacity-slider');
        const valDisplay = dropdown.querySelector('#addon-opacity-val');

        opacitySlider.oninput = (e) => {
            const val = e.target.value;
            valDisplay.textContent = Math.round(val * 100) + '%';
            localStorage.setItem('addon_bg_opacity', val);
            applyCustomBackground();
        };

        //Обработчик для тумблера фиксации фона
        const attachmentToggle = dropdown.querySelector('#addon-attachment-toggle');
        const attachmentSliderUI = dropdown.querySelector('#addon-attachment-slider');
        const attachmentKnob = dropdown.querySelector('#addon-attachment-knob');

        attachmentToggle.onchange = (e) => {
            const isChecked = e.target.checked;
            const newValue = isChecked ? 'fixed' : 'scroll';

            // Анимация самого тумблера
            attachmentSliderUI.style.backgroundColor = isChecked ? '#3b82f6' : '#cbd5e1';
            attachmentKnob.style.transform = isChecked ? 'translateX(14px)' : 'translateX(0)';

            localStorage.setItem('addon_bg_attachment', newValue);
            applyCustomBackground();
        };
    }


  function enhanceAssigneeMenu() {
        const assigneeMenu = document.querySelector('.rdb-menu-assignee');
        if (!assigneeMenu || assigneeMenu.hasAttribute('data-enhanced')) return;

        assigneeMenu.setAttribute('data-enhanced', 'true');

        const assigneeLink = assigneeMenu.querySelector('.rdb-menu-link');
        const oldContainer = assigneeMenu.querySelector('.rdb-container');
        const dialog = document.getElementById('assigneeDialog');

        if (!assigneeLink || !oldContainer || !dialog) return;

        //контейнер
        const customDropdown = document.createElement('div');
        customDropdown.id = 'addon-assignee-dropdown';
        Object.assign(customDropdown.style, {
            position: 'absolute', top: '100%', left: '0', marginTop: '8px',
            backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)', padding: '12px',
            minWidth: '260px', zIndex: '1000', display: 'none',
            flexDirection: 'column', gap: '8px', boxSizing: 'border-box'
        });

        const topLinksNodes = oldContainer.querySelectorAll('.rdb-list:first-child ul li a');
        const topSection = document.createElement('div');
        topSection.style.display = 'flex';
        topSection.style.flexDirection = 'column';
        topSection.style.gap = '2px';

        let urlAll = '';
        let urlNone = '';

        topLinksNodes.forEach(a => {
            const link = document.createElement('a');
            link.href = a.href;
            link.textContent = a.textContent;
            link.className = 'addon-top-link';
            topSection.appendChild(link);

            if (a.textContent.includes('Все ответственные')) urlAll = a.href;
            if (a.textContent.includes('Не назначены')) urlNone = a.href;
        });

        const divider = document.createElement('div');
        divider.style.cssText = "height: 1px; background: #e2e8f0; margin: 4px 0;";

        const form = dialog.querySelector('form');
        if (form) {
            const fieldset = form.querySelector('fieldset');
            if (fieldset) {
                fieldset.style.border = 'none';
                fieldset.style.padding = '0';
                fieldset.style.margin = '0';
            }

            const legend = form.querySelector('legend');
            if (legend) legend.remove();
            const cancelBtn = form.querySelector('#cancelButton');
            if (cancelBtn) cancelBtn.remove();

            const submitBtn = form.querySelector('input[type="submit"][name="commit"]');
            if (submitBtn) {
                submitBtn.value = 'Применить';
                submitBtn.setAttribute('data-disable-with', 'Применить');
                const buttonsContainer = submitBtn.parentElement;
                if (buttonsContainer) buttonsContainer.style.display = 'block';
            }

            const checkAllBox = form.querySelector('#assignees_check_all');
            const checkAllContainer = checkAllBox ? checkAllBox.closest('a') : null;
            const userCheckboxes = Array.from(form.querySelectorAll('.assignees_check'));

            const checkAllLabel = form.querySelector('label[for="assignees_check_all"]');
            if (checkAllLabel) checkAllLabel.textContent = 'Все';

            let counterSpan = null;
            if (checkAllContainer) {
                counterSpan = document.createElement('span');
                counterSpan.style.cssText = 'font-size: 12px; padding: 2px 8px; border-radius: 12px; margin-left: auto; font-weight: 600; min-width: 14px; text-align: center; transition: all 0.2s;';
                checkAllContainer.appendChild(counterSpan);
            }

            function updateCounter() {
                if (!counterSpan) return;
                const count = userCheckboxes.filter(cb => cb.checked).length;
                counterSpan.textContent = count;

                if (count > 0) {
                    counterSpan.style.backgroundColor = '#dbeafe';
                    counterSpan.style.color = '#1d4ed8';
                } else {
                    counterSpan.style.backgroundColor = '#f1f5f9';
                    counterSpan.style.color = '#64748b';
                }
            }

            //синхронизация галочки "Все" по ВИДИМЫМ чекбоксам (нужно для поиска, чтобы все работало корректно только для тех, кто отобразидсляч в результатах поиска
            function syncCheckAll() {
                if (!checkAllBox) return;
                //собираем только тех людей, которые не скрыты фильтром поиска
                const visibleCbs = userCheckboxes.filter(cb => {
                    const li = cb.closest('li');
                    return li && li.style.display !== 'none';
                });

                //если есть видимые и они ВСЕ выбраны ставим галочку "Все"
                if (visibleCbs.length > 0 && visibleCbs.every(cb => cb.checked)) {
                    checkAllBox.checked = true;
                } else {
                    checkAllBox.checked = false;
                }
            }

            syncCheckAll();
            updateCounter();

            form.querySelectorAll('input[type="checkbox"], label').forEach(el => {
                el.style.pointerEvents = 'none';
            });

            form.querySelectorAll('a').forEach(a => {
                a.removeAttribute('onclick');
                a.style.textDecoration = 'none';
                a.style.color = '#334155';
                a.style.fontSize = '13px';
                a.style.padding = '4px 0';
                a.style.display = 'flex';
                a.style.alignItems = 'center';
                a.style.gap = '8px';
                a.style.userSelect = 'none';
                a.style.WebkitUserSelect = 'none';
            });

            if (checkAllContainer && checkAllBox) {
                checkAllContainer.addEventListener('click', (e) => {
                    e.preventDefault();
                    checkAllBox.checked = !checkAllBox.checked;
                    userCheckboxes.forEach(cb => {
                        const li = cb.closest('li');
                        //раздаем галочки только тем, кого видно в фильтре поиска
                        if (li && li.style.display !== 'none') {
                            cb.checked = checkAllBox.checked;
                        }
                    });
                    updateCounter();
                });
            }

            //избранные
            const projectSpan = document.querySelector('.current-project');
            const projectName = projectSpan ? projectSpan.textContent.trim().replace(/[^a-zA-Zа-яА-Я0-9]/g, '_') : 'global';
            const storageKey = 'addon_assignee_favorites_' + projectName;

            const getFavorites = () => JSON.parse(localStorage.getItem(storageKey) || '[]');
            const setFavorites = (favs) => localStorage.setItem(storageKey, JSON.stringify(favs));

            const listItems = [];

            userCheckboxes.forEach(cb => {
                const container = cb.closest('a');
                const li = cb.closest('li');

                if (container && li) {
                    listItems.push(li);

                    const star = document.createElement('span');
                    const isFav = getFavorites().includes(cb.id);
                    const favColor = '#f59e0b';
                    const emptyColor = '#cbd5e1';

                    star.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? favColor : 'none'}" stroke="${isFav ? favColor : emptyColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
                    star.style.cssText = `margin-left: auto; padding: 2px; cursor: pointer; display: flex; align-items: center; opacity: ${isFav ? '1' : '0'}; transition: opacity 0.2s, transform 0.15s;`;

                    container.addEventListener('mouseenter', () => { if (!getFavorites().includes(cb.id)) star.style.opacity = '1'; });
                    container.addEventListener('mouseleave', () => { if (!getFavorites().includes(cb.id)) star.style.opacity = '0'; });

                    star.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        let favs = getFavorites();
                        const nowFav = !favs.includes(cb.id);

                        if (nowFav) favs.push(cb.id);
                        else favs = favs.filter(id => id !== cb.id);
                        setFavorites(favs);

                        const svg = star.querySelector('svg');
                        svg.setAttribute('fill', nowFav ? favColor : 'none');
                        svg.setAttribute('stroke', nowFav ? favColor : emptyColor);
                        star.style.opacity = '1';

                        star.style.transform = 'scale(1.3)';
                        setTimeout(() => star.style.transform = 'scale(1)', 150);

                        sortAndRenderList();
                    });

                    container.appendChild(star);

                    container.addEventListener('click', (e) => {
                        e.preventDefault();
                        cb.checked = !cb.checked;
                        syncCheckAll();
                        updateCounter();
                    });
                }
            });

            const customUl = document.createElement('ul');
            customUl.style.cssText = 'list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;';

            function sortAndRenderList() {
                const favs = getFavorites();
                listItems.sort((a, b) => {
                    const cbA = a.querySelector('.assignees_check');
                    const cbB = b.querySelector('.assignees_check');
                    const isFavA = favs.includes(cbA.id);
                    const isFavB = favs.includes(cbB.id);

                    if (isFavA && !isFavB) return -1;
                    if (!isFavA && isFavB) return 1;

                    const nameA = a.querySelector('label')?.textContent.trim().toLowerCase() || '';
                    const nameB = b.querySelector('label')?.textContent.trim().toLowerCase() || '';
                    return nameA.localeCompare(nameB);
                });

                customUl.innerHTML = '';
                listItems.forEach(li => customUl.appendChild(li));
            }

            //поиск
            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = 'Поиск сотрудника...';
            searchInput.style.cssText = `
                width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 8px;
                border: 1px solid #e2e8f0; border-radius: 6px; font-family: 'Inter', sans-serif;
                font-size: 13px; outline: none; transition: border-color 0.2s; color: #334155;
            `;
            searchInput.onfocus = () => searchInput.style.borderColor = '#3b82f6';
            searchInput.onblur = () => searchInput.style.borderColor = '#e2e8f0';

            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') e.preventDefault();
            });

            searchInput.addEventListener('input', (e) => {
                ///чьтобы Семена можно было искать через ё и через е
                const term = e.target.value.toLowerCase().trim().replace(/ё/g, 'е');
                const searchWords = term.split(/\s+/).filter(w => w.length > 0);

                listItems.forEach(li => {
                    const label = li.querySelector('label');
                    if (label) {
                        const nameWords = label.textContent.toLowerCase().replace(/ё/g, 'е').split(/\s+/);

                        const isMatch = searchWords.every(searchWord =>
                            nameWords.some(nameWord => nameWord.startsWith(searchWord))
                        );

                        li.style.display = (searchWords.length === 0 || isMatch) ? '' : 'none';
                    }
                });

                syncCheckAll();
            });

            if (fieldset) {
                form.insertBefore(searchInput, fieldset);
            }
            //----------------------------------------

            const usersContainer = form.querySelector('fieldset > div[style*="display: flex"]');
            if (usersContainer) {
                usersContainer.innerHTML = '';
                usersContainer.style.cssText = `
                    display: flex;
                    flex-direction: column;
                    max-height: 250px;
                    overflow-y: auto;
                    padding-right: 5px;
                `;
                sortAndRenderList();
                usersContainer.appendChild(customUl);
            }

            if (submitBtn) {
                submitBtn.addEventListener('click', (e) => {
                    const checkedCount = userCheckboxes.filter(cb => cb.checked).length;
                    const totalCount = userCheckboxes.length;

                    if (checkedCount === 0 && urlNone) {
                        e.preventDefault();
                        window.location.href = urlNone;
                    } else if (checkedCount === totalCount && urlAll) {
                        e.preventDefault();
                        window.location.href = urlAll;
                    }
                });
            }
        }

        customDropdown.appendChild(topSection);
        customDropdown.appendChild(divider);
        if (form) customDropdown.appendChild(form);

        assigneeMenu.style.position = 'relative';
        assigneeMenu.appendChild(customDropdown);

        assigneeLink.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            customDropdown.style.display = customDropdown.style.display === 'flex' ? 'none' : 'flex';
            if (oldContainer) oldContainer.style.display = 'none';
            if (customDropdown.style.display === 'flex') {
                const search = customDropdown.querySelector('input[type="text"]');
                if (search) setTimeout(() => search.focus(), 50);
            }
        }, true);

        document.addEventListener('click', (e) => {
            if (!assigneeMenu.contains(e.target)) customDropdown.style.display = 'none';
        });

        dialog.remove();
        const hideObserver = new MutationObserver(() => {
            if (oldContainer.style.display !== 'none') oldContainer.style.display = 'none';
        });
        hideObserver.observe(oldContainer, { attributes: true, attributeFilter: ['style'] });
    }












    // =================================================================================
    // КОНТЕКСТНОЕ МЕНЮ ПКМ, ТУТ РАЗНЕС ПО ФУНКЦИЯМ ЧТОБЫ МОЖНО БЫЛО МАСШТАБИТЬ В БУДУЩЕМ
    // =================================================================================
    function initContextMenu(updateStarsCallback) {
        const FAV_KEY = 'addon_favorite_tasks';
        const getFavs = () => JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
        const setFavs = (favs) => localStorage.setItem(FAV_KEY, JSON.stringify(favs));




        function openGitIssue(project, ctx) {
            let baseUrl = project.url.trim();
            const prefix = project.prefix ? project.prefix.trim() : '';

            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'https://' + baseUrl;
            }

            if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

            if (!baseUrl.endsWith('/-/issues') && !baseUrl.includes('/-/issues/new')) {
                baseUrl += '/-/issues/new';
            } else if (baseUrl.endsWith('/-/issues')) {
                baseUrl += '/new';
            }

            const title = encodeURIComponent(`${prefix}${ctx.taskId}`);
            const desc = encodeURIComponent(ctx.title);
            const finalUrl = `${baseUrl}?issue[title]=${title}&issue[description]=${desc}`;
            window.open(finalUrl, '_blank');
        }

        function showGitIssueModal(type, ctx, projects = []) {
            let overlay = document.getElementById('addon-git-issue-overlay');
            let modal = document.getElementById('addon-git-issue-modal');

            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'addon-git-issue-overlay';
                overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.4); z-index: 10005; backdrop-filter: blur(3px); opacity: 0; transition: opacity 0.2s;';
                document.body.appendChild(overlay);

                modal = document.createElement('div');
                modal.id = 'addon-git-issue-modal';
                //тут переработать логику, чтобы открывалось на 80% по высоте и растягивалось как в адекватных системах
                modal.style.cssText = `
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95);
                    background: #fff; width: 400px; max-height: 80vh; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.3);
                    z-index: 10006; font-family: 'Inter', sans-serif; display: flex; flex-direction: column;
                    opacity: 0; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); overflow: hidden;
                `;
                document.body.appendChild(modal);

                overlay.addEventListener('click', closeModal);
            }


            function closeModal() {
                overlay.style.opacity = '0';
                modal.style.opacity = '0';
                modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
                setTimeout(() => { overlay.style.display = 'none'; modal.style.display = 'none'; }, 200);
            }

            let contentHtml = '';

            if (type === 'empty') {
                contentHtml = `
                    <div style="padding: 24px; text-align: center; display: flex; flex-direction: column; gap: 16px; align-items: center; overflow-y: auto;">
                        <div style="width: 48px; height: 48px; background: #fee2e2; color: #ef4444; border-radius: 50%; display: flex; justify-content: center; align-items: center; flex-shrink: 0;">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                        </div>
                        <div>
                            <h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #0f172a;">GIT не настроен</h3>
                            <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">Для этого проекта не добавлено ни одной ссылки на репозиторий.<br><br>Зайдите в <b>Настройки</b> <i>(на этой странице справа сверху)</i> <b>➔ Взаимодействие с GIT</b> и добавьте все репозитории, которые относятся к этому проекту.</p>
                        </div>
                        <input type="button" value="Понятно" id="git-issue-close-btn" style="-webkit-appearance: none !important; appearance: none !important; display: flex !important; align-items: center !important; justify-content: center !important; width: 100% !important; margin: 8px 0 0 0 !important; padding: 8px !important; border-radius: 6px !important; background-color: #2563eb !important; color: #ffffff !important; border: none !important; box-shadow: none !important; text-shadow: none !important; font-family: 'Inter', sans-serif !important; font-size: 13px !important; font-weight: 600 !important; text-transform: none !important; letter-spacing: normal !important; cursor: pointer !important; transition: background-color 0.2s !important; height: auto !important; line-height: 1.5 !important; flex-shrink: 0;">
                    </div>
                `;
            } else if (type === 'select') {
                contentHtml = `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
                        <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #0f172a;">Выберите репозиторий</h3>
                        <svg id="git-issue-close-icon" style="cursor: pointer; color: #64748b; transition: color 0.2s;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </div>
                    <div style="padding: 20px; display: flex; flex-direction: column; gap: 8px; flex-grow: 1; min-height: 0; overflow-y: auto;">
                        ${projects.map((p, index) => `
                            <div class="git-select-item" data-index="${index}" style="padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; transition: all 0.2s; display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;">
                                <span style="font-weight: 600; font-size: 13px; color: #334155;">${p.note} <span style="color: #94a3b8; font-weight: normal; font-size: 11px;">(${p.prefix ? p.prefix : 'без префикса'})</span></span>
                                <span style="font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.url}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            modal.innerHTML = contentHtml;
            if (type === 'empty') {
                const btn = modal.querySelector('#git-issue-close-btn');
                btn.onmouseenter = () => btn.style.backgroundColor = '#1d4ed8';
                btn.onmouseleave = () => btn.style.backgroundColor = '#2563eb';
                btn.onclick = closeModal;
            } else if (type === 'select') {
                const closeIcon = modal.querySelector('#git-issue-close-icon');
                closeIcon.onmouseenter = () => closeIcon.style.color = '#0f172a';
                closeIcon.onmouseleave = () => closeIcon.style.color = '#64748b';
                closeIcon.onclick = closeModal;

                modal.querySelectorAll('.git-select-item').forEach((item, index) => {
                    item.onmouseenter = () => { item.style.backgroundColor = '#f1f5f9'; item.style.borderColor = '#cbd5e1'; };
                    item.onmouseleave = () => { item.style.backgroundColor = '#f8fafc'; item.style.borderColor = '#e2e8f0'; };
                    item.onclick = () => {
                        const project = projects[index];
                        openGitIssue(project, ctx);
                        closeModal();
                    };
                });
            }

            overlay.style.display = 'block';
            modal.style.display = 'flex';
            setTimeout(() => {
                overlay.style.opacity = '1';
                modal.style.opacity = '1';
                modal.style.transform = 'translate(-50%, -50%) scale(1)';
            }, 10);
        }



        const projectSpan = document.querySelector('.current-project');
        const projectName = projectSpan ? projectSpan.textContent.trim() : 'Глобальный';

        let contextMenu = document.getElementById('addon-context-menu');
        if (!contextMenu) {
            contextMenu = document.createElement('div');
            contextMenu.id = 'addon-context-menu';
            contextMenu.style.cssText = `
                position: fixed; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.15); padding: 6px 0; min-width: 220px;
                z-index: 10005; display: none; font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500;
            `;
            document.body.appendChild(contextMenu);

            document.addEventListener('click', () => contextMenu.style.display = 'none');
            window.addEventListener('scroll', () => contextMenu.style.display = 'none', true);
        }

        const board = document.getElementById('rdb-board');
        if (!board || board.hasAttribute('data-context-init')) return;
        board.setAttribute('data-context-init', 'true');

        // ==========================================
        // vjlekb lkz vty.
        // ==========================================

        const createMenuItem = (iconSvg, text, color, onClick) => {
            const item = document.createElement('div');
            item.style.cssText = `padding: 8px 16px; cursor: pointer; display: flex; align-items: center; gap: 8px; color: ${color}; transition: background 0.2s;`;
            item.innerHTML = `${iconSvg} <span>${text}</span>`;

            item.onmouseenter = () => item.style.backgroundColor = '#f1f5f9';
            item.onmouseleave = () => item.style.backgroundColor = 'transparent';

            item.onclick = (event) => {
                event.stopPropagation();
                onClick(item);
            };
            return item;
        };

        const createDivider = () => {
            const div = document.createElement('div');
            div.style.cssText = 'height: 1px; background: #e2e8f0; margin: 4px 0;';
            return div;
        };

        const createSectionHeader = (text) => {
            const div = document.createElement('div');
            div.style.cssText = 'font-size: 11px; color: #94a3b8; padding: 4px 16px; text-transform: uppercase; font-weight: 600;';
            div.textContent = text;
            return div;
        };

        // рудимент для создания ветки в гит, отказался от этого фукнционала, вырезать очень осторожно
        const makeFeatureName = (taskId, text) => {
            const cyrillic = {
                'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
                'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
                'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts',
                'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
            };

            const transliterated = text.toLowerCase().split('').map(char => cyrillic[char] || char).join('');

            //удаляем символы кроме буков и дефисов
            const cleanText = transliterated.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

            return `${taskId}-${cleanText}`;
        };

        //трудозатраты
        const moduleLogTime = (ctx) => {
            const icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;

            return createMenuItem(icon, 'Добавить трудозатраты', '#334155', () => {
                const timeEntryUrl = `${window.location.origin}/issues/${ctx.taskId}/time_entries/new`;
                contextMenu.style.display = 'none';
                if (typeof openModal === 'function') {
                    openModal(timeEntryUrl, ctx.card);
                } else {
                    window.open(timeEntryUrl, '_blank');
                }
            });
        };

        //приортиет
        const modulePriorities = (ctx) => {
            const links = Array.from(ctx.card.querySelectorAll('.rdb-issue-menu-progress a'));
            if (links.length === 0) return null;

            const fragment = document.createDocumentFragment();
            fragment.appendChild(createSectionHeader('Изменить приоритет'));

            // Строим меню строго по порядку из PRIORITIES_CONFIG
            PRIORITIES_CONFIG.forEach(item => {
                const link = links.find(l => l.closest('li').classList.contains(item.id));
                if (link) {
                    const icon = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${item.color}"/></svg>`;
                    fragment.appendChild(createMenuItem(icon, item.label, '#334155', () => {
                        link.click();
                        contextMenu.style.display = 'none';
                    }));
                }
            });

            return fragment;
        };


        //избранное
        const moduleFavorite = (ctx) => {
            let favs = getFavs();
            const isFav = favs.some(f => f.id === ctx.taskId);

            const icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'none' : '#f59e0b'}" stroke="${isFav ? '#dc2626' : '#f59e0b'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                ${isFav ? '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>' : '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>'}
            </svg>`;

            return createMenuItem(icon, isFav ? 'Убрать из избранного' : 'Добавить в избранное', isFav ? '#dc2626' : '#334155', () => {
                favs = getFavs();
                const existingIndex = favs.findIndex(f => f.id === ctx.taskId);
                if (existingIndex === -1) {
                    favs.push({ id: ctx.taskId, project: projectName, assignee: ctx.assignee, title: ctx.title, url: ctx.taskUrl, timestamp: new Date().getTime() });
                } else {
                    favs.splice(existingIndex, 1);
                }
                setFavs(favs);
                if (updateStarsCallback) updateStarsCallback();
                contextMenu.style.display = 'none';
            });
        };


        //ишью в гите
        const moduleCreateGitIssue = (ctx) => {
            const projectSpan = document.querySelector('.current-project');
            const projName = projectSpan ? projectSpan.textContent.trim().replace(/[^a-zA-Zа-яА-Я0-9]/g, '_') : 'global';

            const issueIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;

            return createMenuItem(issueIcon, 'Создать issue', '#334155', () => {
                contextMenu.style.display = 'none';
                const projects = JSON.parse(localStorage.getItem('addon_git_projects_' + projName) || '[]');

                if (projects.length === 0) {
                    showGitIssueModal('empty', ctx);
                } else if (projects.length === 1) {
                    openGitIssue(projects[0], ctx); //ВАЖНО!11!!!!!!: передаем projects[0], а не projects[0].url
                } else {
                    showGitIssueModal('select', ctx, projects);
                }
            });
        };

        //имя фичи //временно вырезал функциональность!
        /*const moduleCopyFeatureName = (ctx) => {
            const icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
            return createMenuItem(icon, 'Имя ветки (на латинице)', '#334155', (itemNode) => {
                const branchName = makeFeatureName(ctx.taskId, ctx.title);
                navigator.clipboard.writeText(branchName).then(() => {
                    const span = itemNode.querySelector('span');
                    span.textContent = 'Скопировано!';
                    itemNode.style.color = '#16a34a';
                    itemNode.querySelector('svg').setAttribute('stroke', '#16a34a');
                    setTimeout(() => contextMenu.style.display = 'none', 500);
                });
            });
        }; */

        //копировать ссылку
        const moduleCopyLink = (ctx) => {
            const icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
            return createMenuItem(icon, 'Копировать ссылку', '#334155', (itemNode) => {
                navigator.clipboard.writeText(ctx.taskUrl).then(() => {
                    const span = itemNode.querySelector('span');
                    span.textContent = 'Скопировано!';
                    itemNode.style.color = '#16a34a';
                    itemNode.querySelector('svg').setAttribute('stroke', '#16a34a');
                    setTimeout(() => contextMenu.style.display = 'none', 500);
                });
            });
        };



        // ==========================================
        // СБОРКА
        // ==========================================

        board.addEventListener('contextmenu', (e) => {
            const card = e.target.closest('.rdb-card');
            if (!card) return;

            e.preventDefault();

            const header = card.querySelector('.rdb-card-header');
            const idLink = header ? header.querySelector('.rdb-menu-link') : null;
            if (!idLink) return;

            const ctx = {
                card: card,
                taskId: idLink.textContent.trim().replace('#', ''),
                assignee: header.querySelector('.rdb-property-assignee')?.textContent.trim() || 'Не назначен',
                title: card.querySelector('.rdb-property-subject')?.textContent.trim() || 'Без названия',
                taskUrl: window.location.origin + '/issues/' + idLink.textContent.trim().replace('#', '')
            };

            contextMenu.innerHTML = '';

            contextMenu.appendChild(moduleFavorite(ctx));
            contextMenu.appendChild(createDivider());

            const priorityNode = modulePriorities(ctx);
            if (priorityNode) {
                contextMenu.appendChild(priorityNode);
                contextMenu.appendChild(createDivider());
            }

            const logTimeNode = moduleLogTime(ctx);
            if (logTimeNode) {
                contextMenu.appendChild(logTimeNode);
                contextMenu.appendChild(createDivider());
            }

            contextMenu.appendChild(moduleCreateGitIssue(ctx));

            //никогда не расскоменчивать, протестить если все ок, то удалить эту строку ниже
            // contextMenu.appendChild(moduleCopyFeatureName(ctx));
            contextMenu.appendChild(moduleCopyLink(ctx));

            let x = e.clientX;
            let y = e.clientY;
            contextMenu.style.display = 'block';
            const rect = contextMenu.getBoundingClientRect();

            if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 10;
            if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 10;

            contextMenu.style.left = x + 'px';
            contextMenu.style.top = y + 'px';
        });
    }










    // =================================================================================
    // избранные, менюха
    // =================================================================================

    function injectFavoriteMenu() {
        if (document.getElementById('addon-fav-btn-container')) return;

        const rolesMenu = document.querySelector('.rdb-menu-roles');
        if (!rolesMenu) return;
        const rolesFilterBlock = rolesMenu.closest('.rdb-filter');
        if (!rolesFilterBlock) return;

        const FAV_KEY = 'addon_favorite_tasks';
        const getFavs = () => JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
        const setFavs = (favs) => localStorage.setItem(FAV_KEY, JSON.stringify(favs));

        const projectSpan = document.querySelector('.current-project');
        const currentProjectName = projectSpan ? projectSpan.textContent.trim() : 'Глобальный';

        const SORT_KEY = 'addon_fav_sort_modal';
        let currentSort = localStorage.getItem(SORT_KEY) || 'date_desc';
        let bulkDeleteState = false;
        let selectedProjectFilter = currentProjectName;

        //кнопка на панели
        const container = document.createElement('div');
        container.id = 'addon-fav-btn-container';
        container.style.cssText = 'position: relative; float: left; display: flex; align-items: center; padding-top: 3px; margin-left: 8px;';

        const btn = document.createElement('div');
        btn.className = 'addon-toggle-btn';
        btn.style.margin = '0';
        btn.title = 'Избранные задачи';
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
            <span>Избранное</span>
        `;
        container.appendChild(btn);
        rolesFilterBlock.parentNode.insertBefore(container, rolesFilterBlock.nextSibling);

        let overlay = document.getElementById('addon-fav-overlay');
        let modal = document.getElementById('addon-fav-modal');

        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'addon-fav-overlay';
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.4); z-index: 10005; backdrop-filter: blur(3px); opacity: 0; transition: opacity 0.2s; display: none;';
            document.body.appendChild(overlay);

            modal = document.createElement('div');
            modal.id = 'addon-fav-modal';
            modal.style.cssText = `
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95);
                background: #fff; width: 850px; max-width: 90vw; max-height: 80vh; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.3);
                z-index: 10006; font-family: 'Inter', sans-serif; display: flex; flex-direction: column;
                opacity: 0; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); overflow: hidden; display: none;
            `;
            document.body.appendChild(modal);

            overlay.addEventListener('click', closeFavModal);
        }

        //контейнер для тултипа
        let tooltip = document.getElementById('addon-fav-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'addon-fav-tooltip';
            tooltip.style.cssText = `
                position: fixed; z-index: 10007; background: #fff; border: 1px solid #e2e8f0;
                border-radius: 6px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); padding: 6px 12px;
                font-family: 'Inter', sans-serif; font-size: 13px; color: #0f172a; font-weight: 600;
                pointer-events: none; display: none; max-width: 450px; white-space: normal; word-wrap: break-word;
            `;
            document.body.appendChild(tooltip);
        }
        //фиксация отложенных удалений
        function applyPendingFavDeletions() {
            let favs = getFavs();
            let changed = false;
            const rows = modal.querySelectorAll('.addon-fav-row');
            rows.forEach(row => {
                if (row.getAttribute('data-marked-delete') === 'true') {
                    const taskId = row.getAttribute('data-task-id');
                    favs = favs.filter(f => f.id !== taskId);
                    changed = true;
                }
            });
            if (changed) {
                setFavs(favs);
                if (typeof updateStars === 'function') updateStars();
            }
        }

        function closeFavModal() {
            applyPendingFavDeletions();
            overlay.style.opacity = '0';
            modal.style.opacity = '0';
            modal.style.transform = 'translate(-50%, -50%) scale(0.95)';

            //прячем тултип, если окно закрылось
            const tt = document.getElementById('addon-fav-tooltip');
            if (tt) tt.style.display = 'none';

            setTimeout(() => { overlay.style.display = 'none'; modal.style.display = 'none'; }, 200);
        }

        function renderFavModal() {
            let favs = getFavs();
            bulkDeleteState = false;

            //собираем уникальные проекты
            const uniqueProjects = [...new Set(favs.map(f => f.project))];
            if (!uniqueProjects.includes(currentProjectName)) {
                uniqueProjects.push(currentProjectName);
            }
            uniqueProjects.sort();

            //фильтруем
            const filteredFavs = favs.filter(f => selectedProjectFilter === 'ALL' || f.project === selectedProjectFilter);

            //сортируем
            filteredFavs.sort((a, b) => {
                if (currentSort.startsWith('name')) {
                    const cmp = a.assignee.localeCompare(b.assignee);
                    return currentSort === 'name_asc' ? cmp : -cmp;
                } else if (currentSort.startsWith('project')) {
                    const cmp = a.project.localeCompare(b.project);
                    return currentSort === 'project_asc' ? cmp : -cmp;
                } else {
                    const cmp = a.timestamp - b.timestamp;
                    return currentSort === 'date_asc' ? cmp : -cmp;
                }
            });

            const iconRestore = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
            const iconTrash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

            const selectHtml = `
                <select id="addon-fav-project-select" style="height: 32px; box-sizing: border-box; padding: 0 30px 0 12px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 13px; color: #334155; background: #fff; outline: none; cursor: pointer; max-width: 400px; text-overflow: ellipsis; font-family: 'Inter', sans-serif;">
                    <option value="ALL" ${selectedProjectFilter === 'ALL' ? 'selected' : ''}>Все проекты</option>
                    ${uniqueProjects.map(p => `<option value="${p}" ${selectedProjectFilter === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select>
            `;

            modal.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
        <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 8px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            Избранные задачи (${filteredFavs.length})
        </h3>
        <svg id="addon-fav-close" style="cursor: pointer; color: #64748b; transition: color 0.2s;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </div>

    <div style="padding: 12px 20px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; background: #f8fafc; flex-shrink: 0;">
        <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
            ${selectHtml}

            ${filteredFavs.length > 0 ? `
            <div style="display: flex; gap: 6px; font-size: 13px; user-select: none; align-items: center;">
                <span id="sort-btn-name" style="height: 32px; box-sizing: border-box; display: inline-flex; align-items: center; cursor:pointer; padding: 0 12px; border-radius: 6px; transition: background 0.2s; border: 1px solid transparent;"></span>
                <span id="sort-btn-date" style="height: 32px; box-sizing: border-box; display: inline-flex; align-items: center; cursor:pointer; padding: 0 12px; border-radius: 6px; transition: background 0.2s; border: 1px solid transparent;"></span>
                ${selectedProjectFilter === 'ALL' ? `<span id="sort-btn-project" style="height: 32px; box-sizing: border-box; display: inline-flex; align-items: center; cursor:pointer; padding: 0 12px; border-radius: 6px; transition: background 0.2s; border: 1px solid transparent;"></span>` : ''}
            </div>
            ` : ''}
        </div>
        ${filteredFavs.length > 0 ? `<div id="addon-fav-bulk-btn" style="height: 32px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; color: #dc2626; cursor: pointer; transition: all 0.2s; font-weight: 500; padding: 0 16px; border-radius: 6px; background: #fee2e2;">Удалить все</div>` : ''}
    </div>

    <div id="addon-fav-list" style="padding: 20px; display: flex; flex-direction: column; gap: 8px; flex-grow: 1; min-height: 0; overflow-y: auto;">
        ${filteredFavs.length === 0 ? `
            <div style="color: #64748b; text-align: center; padding: 40px 0; font-size: 14px;">
                ${selectedProjectFilter === 'ALL'
                    ? 'У вас пока нет избранных задач.'
                    : 'В этом проекте пока нет избранных задач<br><br>Кликните правой кнопкой мыши по карточке на доске, чтобы добавить задачу в избранное<br><br><img src="https://pr.isands.ru/attachments/download/179618/ezgif-3eccbe603a709bc8.gif" style="max-width: 480px; border-radius: 8px; margin-top: 10px;" alt="Waiting"><br><br>Эти задачи будут видны только вам'}
            </div>
        ` :
        filteredFavs.map(task => {
            const date = new Date(task.timestamp);
            const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

            const projectBadgeHtml = selectedProjectFilter === 'ALL'
                ? `<div style="font-size: 11px; color: #475569; background: #e2e8f0; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; margin-bottom: 6px; width: fit-content;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>${task.project}</div>`
                : '';

            return `
                <div class="addon-fav-row" data-task-id="${task.id}" data-marked-delete="false" style="display: flex; align-items: center; justify-content: space-between; background: #fff; padding: 12px 16px; border-radius: 8px; border: 1px solid #e2e8f0; flex-shrink: 0; transition: all 0.2s;">
                    <div style="flex: 0 0 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: #334155; font-size: 13px;" title="${task.assignee}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                        ${task.assignee}
                    </div>
                    <div style="flex: 1 1 auto; margin: 0 16px; overflow: hidden; display: flex; flex-direction: column; justify-content: center;">
                        ${projectBadgeHtml}
                        <a href="${task.url}" class="addon-fav-link" style="color: #2563eb; text-decoration: none; font-weight: 500; font-size: 14px; transition: color 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">#${task.id} ${task.title}</a>
                    </div>
                    <div style="flex: 0 0 100px; color: #64748b; font-size: 12px; text-align: right; margin-right: 16px;">
                        ${dateStr}
                    </div>
                    <div class="addon-fav-toggle-del" style="flex: 0 0 32px; height: 32px; cursor: pointer; display: flex; justify-content: center; align-items: center; border-radius: 6px; transition: all 0.2s; background: transparent; color: #ef4444;" title="Удалить">
                        ${iconTrash}
                    </div>
                </div>
            `;
        }).join('')}
    </div>
`;

            const closeBtn = modal.querySelector('#addon-fav-close');
            closeBtn.onmouseenter = () => closeBtn.style.color = '#0f172a';
            closeBtn.onmouseleave = () => closeBtn.style.color = '#64748b';
            closeBtn.onclick = closeFavModal;

            const projectSelect = modal.querySelector('#addon-fav-project-select');
            projectSelect.addEventListener('change', (e) => {
                applyPendingFavDeletions(); //сохраняем удаления перед сменой фильтра
                selectedProjectFilter = e.target.value;
                renderFavModal();
            });

            function updateSortHeaders() {
                const nameEl = modal.querySelector('#sort-btn-name');
                const dateEl = modal.querySelector('#sort-btn-date');
                const projectEl = modal.querySelector('#sort-btn-project');

                const activeBg = '#dbeafe'; const activeColor = '#1d4ed8'; const activeBorder = '#bfdbfe';
                const inactiveBg = '#f8fafc'; const inactiveColor = '#64748b'; const inactiveBorder = '#e2e8f0';

                if (nameEl) {
                    nameEl.style.color = currentSort.startsWith('name') ? activeColor : inactiveColor;
                    nameEl.style.background = currentSort.startsWith('name') ? activeBg : inactiveBg;
                    nameEl.style.borderColor = currentSort.startsWith('name') ? activeBorder : inactiveBorder;
                    nameEl.innerHTML = 'Сотрудник ' + (currentSort === 'name_asc' ? '↓' : currentSort === 'name_desc' ? '↑' : '');
                }
                if (dateEl) {
                    dateEl.style.color = currentSort.startsWith('date') ? activeColor : inactiveColor;
                    dateEl.style.background = currentSort.startsWith('date') ? activeBg : inactiveBg;
                    dateEl.style.borderColor = currentSort.startsWith('date') ? activeBorder : inactiveBorder;
                    dateEl.innerHTML = 'Дата ' + (currentSort === 'date_asc' ? '↑' : currentSort === 'date_desc' ? '↓' : '');
                }
                if (projectEl) {
                    projectEl.style.color = currentSort.startsWith('project') ? activeColor : inactiveColor;
                    projectEl.style.background = currentSort.startsWith('project') ? activeBg : inactiveBg;
                    projectEl.style.borderColor = currentSort.startsWith('project') ? activeBorder : inactiveBorder;
                    projectEl.innerHTML = 'Проект ' + (currentSort === 'project_asc' ? '↓' : currentSort === 'project_desc' ? '↑' : '');

                    projectEl.onclick = (e) => {
                        e.stopPropagation();
                        currentSort = currentSort === 'project_asc' ? 'project_desc' : 'project_asc';
                        localStorage.setItem(SORT_KEY, currentSort);
                        renderFavModal();
                    };
                }
            }

            if (filteredFavs.length > 0) {
                updateSortHeaders();

                modal.querySelector('#sort-btn-name').onclick = (e) => {
                    e.stopPropagation();
                    currentSort = currentSort === 'name_asc' ? 'name_desc' : 'name_asc';
                    localStorage.setItem(SORT_KEY, currentSort);
                    renderFavModal();
                };

                modal.querySelector('#sort-btn-date').onclick = (e) => {
                    e.stopPropagation();
                    currentSort = currentSort === 'date_desc' ? 'date_asc' : 'date_desc';
                    localStorage.setItem(SORT_KEY, currentSort);
                    renderFavModal();
                };

                const bulkBtn = modal.querySelector('#addon-fav-bulk-btn');
                bulkBtn.onclick = (e) => {
                    e.stopPropagation();
                    const rows = modal.querySelectorAll('.addon-fav-row');
                    if (!bulkDeleteState) {
                        bulkDeleteState = true;
                        bulkBtn.textContent = 'Отменить удаление';
                        bulkBtn.style.color = '#16a34a';
                        bulkBtn.style.background = '#dcfce7';
                        rows.forEach(row => {
                            if (row.getAttribute('data-marked-delete') !== 'true') {
                                row.setAttribute('data-marked-delete', 'true');
                                row.setAttribute('data-bulk-deleted', 'true');
                                row.style.opacity = '0.4';
                                const btn = row.querySelector('.addon-fav-toggle-del');
                                btn.style.color = '#16a34a';
                                btn.innerHTML = iconRestore;
                            }
                        });
                    } else {
                        bulkDeleteState = false;
                        bulkBtn.textContent = 'Удалить все';
                        bulkBtn.style.color = '#dc2626';
                        bulkBtn.style.background = '#fee2e2';
                        rows.forEach(row => {
                            if (row.getAttribute('data-bulk-deleted') === 'true') {
                                row.setAttribute('data-marked-delete', 'false');
                                row.setAttribute('data-bulk-deleted', 'false');
                                row.style.opacity = '1';
                                const btn = row.querySelector('.addon-fav-toggle-del');
                                btn.style.color = '#ef4444';
                                btn.innerHTML = iconTrash;
                            }
                        });
                    }
                };

                modal.querySelectorAll('.addon-fav-row').forEach(row => {
                    const link = row.querySelector('.addon-fav-link');

                    //логика тултипа при наведении
                    link.onmouseenter = (e) => {
                        link.style.color = '#1d4ed8';
                        const tt = document.getElementById('addon-fav-tooltip');
                        if (tt) {
                            tt.textContent = link.textContent.trim();
                            tt.style.display = 'block';

                            //позиционируем рядом с курсором
                            let left = e.clientX + 15;
                            let top = e.clientY + 15;
                            const rect = tt.getBoundingClientRect();

                            //защита от вылезания за края экрана
                            if (left + rect.width > window.innerWidth) left = e.clientX - rect.width - 15;
                            if (top + rect.height > window.innerHeight) top = e.clientY - rect.height - 15;

                            tt.style.left = left + 'px';
                            tt.style.top = top + 'px';
                        }
                    };

                    //чтобы двигался за мышкой когда двигаем крсор
                    link.onmousemove = (e) => {
                        const tt = document.getElementById('addon-fav-tooltip');
                        if (tt && tt.style.display === 'block') {
                            let left = e.clientX + 15;
                            let top = e.clientY + 15;
                            const rect = tt.getBoundingClientRect();

                            if (left + rect.width > window.innerWidth) left = e.clientX - rect.width - 15;
                            if (top + rect.height > window.innerHeight) top = e.clientY - rect.height - 15;

                            tt.style.left = left + 'px';
                            tt.style.top = top + 'px';
                        }
                    };

                    link.onmouseleave = () => {
                        link.style.color = '#2563eb';
                        const tt = document.getElementById('addon-fav-tooltip');
                        if (tt) tt.style.display = 'none';
                    };

                    link.onclick = (e) => {
                        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        closeFavModal();
                        openModal(link.getAttribute('href'), null);
                    };

                    const btn = row.querySelector('.addon-fav-toggle-del');
                    btn.onmouseenter = () => {
                        const isMarked = row.getAttribute('data-marked-delete') === 'true';
                        btn.style.backgroundColor = isMarked ? '#bbf7d0' : '#fecaca';
                    };
                    btn.onmouseleave = () => {
                        btn.style.backgroundColor = 'transparent';
                    };

                    btn.onclick = () => {
                        const isMarked = row.getAttribute('data-marked-delete') === 'true';
                        if (!isMarked) {
                            row.setAttribute('data-marked-delete', 'true');
                            row.setAttribute('data-bulk-deleted', 'false');
                            row.style.opacity = '0.4';
                            btn.style.color = '#16a34a';
                            btn.innerHTML = iconRestore;
                        } else {
                            row.setAttribute('data-marked-delete', 'false');
                            row.setAttribute('data-bulk-deleted', 'false');
                            row.style.opacity = '1';
                            btn.style.color = '#ef4444';
                            btn.innerHTML = iconTrash;
                        }
                        btn.style.transform = 'scale(1.2)';
                        setTimeout(() => btn.style.transform = 'scale(1)', 150);
                    };
                });
            }
        }

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (overlay.style.display === 'block') {
                closeFavModal();
            } else {
                renderFavModal();
                overlay.style.display = 'block';
                modal.style.display = 'flex';
                setTimeout(() => {
                    overlay.style.opacity = '1';
                    modal.style.opacity = '1';
                    modal.style.transform = 'translate(-50%, -50%) scale(1)';
                }, 10);
            }
        });
    }







   // =================================================================================
    // меню настроек
    // =================================================================================

    function enhanceSettingsMenu() {
        const settingsMenu = document.querySelector('.rdb-menu-options');
        if (!settingsMenu || settingsMenu.hasAttribute('data-enhanced')) return;

        settingsMenu.setAttribute('data-enhanced', 'true');

        const settingsLink = settingsMenu.querySelector('.rdb-menu-link');
        const oldContainer = settingsMenu.querySelector('.rdb-container');
        if (!settingsLink || !oldContainer) return;

        const customDropdown = document.createElement('div');
        customDropdown.id = 'addon-settings-dropdown';
        Object.assign(customDropdown.style, {
            position: 'absolute', top: '100%', right: '0', marginTop: '8px',
            backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)', padding: '12px',
            minWidth: '260px', zIndex: '1000', display: 'none',
            flexDirection: 'column', gap: '2px', boxSizing: 'border-box'
        });

        const createHeader = (text) => {
            const div = document.createElement('div');
            div.className = 'addon-settings-header';
            div.textContent = text;
            return div;
        };

        const createDivider = () => {
            const div = document.createElement('div');
            div.className = 'addon-settings-divider';
            return div;
        };

        const createSmartToggle = (title, tooltipIcon, storageKey, onToggle) => {
            const row = document.createElement('div');
            row.className = 'addon-list-link';
            row.style.justifyContent = 'space-between';

            let isChecked = localStorage.getItem(storageKey) === 'true' ||
                            (storageKey === 'addon_bg_attachment' && (localStorage.getItem(storageKey) || 'fixed') === 'fixed');

            row.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <label>${title}</label>
                    ${tooltipIcon ? `<span title="${tooltipIcon}" style="cursor: help; display: flex; align-items: center; pointer-events: auto;"><svg stroke="#94a3b8" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></span>` : ''}
                </div>
                <div style="position: relative; width: 32px; height: 18px; flex-shrink: 0; pointer-events: none;">
                    <div class="tgl-bg" style="position: absolute; inset: 0; background-color: ${isChecked ? '#3b82f6' : '#cbd5e1'}; transition: 0.2s; border-radius: 18px;">
                        <div class="tgl-knob" style="position: absolute; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: 0.2s; border-radius: 50%; transform: ${isChecked ? 'translateX(14px)' : 'translateX(0)'};"></div>
                    </div>
                </div>
            `;

            const bg = row.querySelector('.tgl-bg');
            const knob = row.querySelector('.tgl-knob');

            row.onclick = (e) => {
                e.stopPropagation();
                isChecked = !isChecked;
                bg.style.backgroundColor = isChecked ? '#3b82f6' : '#cbd5e1';
                knob.style.transform = isChecked ? 'translateX(14px)' : 'translateX(0)';
                onToggle(isChecked);
            };
            return row;
        };

        // ==========================================
        // СБОРКА МОДУЛЕЙ
        // ==========================================

        //Полный экран, очистить фильтр
        const topSection = document.createElement('div');
        topSection.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

        ['rdb-option-fullscreen', 'rdb-reset'].forEach(id => {
            const nativeA = oldContainer.querySelector(`#${id}`);
            if (nativeA) {
                const a = document.createElement('a');
                a.className = 'addon-top-link';

                if (id === 'rdb-option-fullscreen') {
                    a.id = 'addon-custom-fullscreen-btn';
                    a.href = '#';
                    const currentText = window.isAddonFullscreen ? 'Обычный экран' : 'Полный экран';
                    a.innerHTML = `<label style="font-weight: 500; cursor: pointer;">${currentText}</label>`;

                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        window.toggleAddonFullscreen(); //дергаем глобальную функцию, вынес в глобалку чтобы можно было горячую клавишу назначить, сейчас сттит на F
                        setTimeout(() => customDropdown.style.display = 'none', 50);
                    });
                } else {
                    a.href = nativeA.href;
                    if (nativeA.getAttribute('onclick')) a.setAttribute('onclick', nativeA.getAttribute('onclick'));
                    a.innerHTML = `<label style="font-weight: 500; cursor: pointer;">${nativeA.textContent.trim()}</label>`;
                    a.addEventListener('click', () => setTimeout(() => customDropdown.style.display = 'none', 50));
                }

                topSection.appendChild(a);
            }
        });

        if (topSection.children.length > 0) {
            customDropdown.appendChild(topSection);
            customDropdown.appendChild(createDivider());
        }

        //настройки редмайна, пробрасываем и накидываем стиля
        const nativeSection = document.createElement('div');
        nativeSection.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

        const nativeLists = Array.from(oldContainer.querySelectorAll('.rdb-list'));
        nativeLists.forEach((list, index) => {
            if (list.querySelector('#rdb-option-fullscreen')) return;

            const titleEl = list.querySelector('h3');
            const titleText = titleEl ? titleEl.textContent.trim() : (index === 0 ? 'Встроено в Redmine' : '');
            if (titleText) {
                const header = createHeader(titleText);
                if (nativeSection.children.length === 0) header.style.paddingTop = '4px';
                nativeSection.appendChild(header);
            }

            Array.from(list.querySelectorAll('a')).forEach(nativeA => {
                const isCheckbox = nativeA.classList.contains('rdb-checkbox-link') || nativeA.classList.contains('rdb-checkbox-link-enabled');
                const isChecked = nativeA.classList.contains('rdb-checkbox-link-enabled');

                const a = document.createElement('a');
                a.className = 'addon-list-link';
                a.href = nativeA.href;

                if (isCheckbox) {
                    a.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''}><label>${nativeA.textContent.trim()}</label>`;
                } else {
                    a.innerHTML = `<label style="font-weight: 500; cursor: pointer;">${nativeA.textContent.trim()}</label>`;
                }

                a.addEventListener('click', () => setTimeout(() => customDropdown.style.display = 'none', 50));
                nativeSection.appendChild(a);
            });
        });
        customDropdown.appendChild(nativeSection);
        customDropdown.appendChild(createDivider());

        const toolsSection = document.createElement('div');
        toolsSection.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
        toolsSection.appendChild(createHeader('Функции для удобства'));

        //гит
        const gitSettingsBtn = document.createElement('a');
        gitSettingsBtn.className = 'addon-top-link'; // подтягиваем стили от верхних кнопок просто, чтобы не делать новый лкасс
        gitSettingsBtn.href = '#';
        gitSettingsBtn.innerHTML = `
            <label style="font-weight: 600; cursor: pointer; display: flex; align-items: center; width: 100%;">
                Взаимодействие с GIT
            </label>
        `;
        gitSettingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            customDropdown.style.display = 'none';
            openGitSettingsModal();
        });
        toolsSection.appendChild(gitSettingsBtn);
        // -------------------------

        toolsSection.appendChild(createSmartToggle('Авто-обновление доски', 'Автоматически синхронизировать доску с изменениями в задаче после её закрытия. Вам не придется обновлять страницу вручную, чтобы увидеть новый статус или ответственного, доска сама подтянет свежие данные, как только вы закроете модальное окно', 'addon_autorefresh', (val) => {
            localStorage.setItem('addon_autorefresh', val);
        }));

        customDropdown.appendChild(toolsSection);
        customDropdown.appendChild(createDivider());

        //фон
        const bgSection = document.createElement('div');
        bgSection.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

        const bgHeader = createHeader('Фоновое изображение');
        bgHeader.style.paddingTop = '4px';
        bgSection.appendChild(bgHeader);

        const bgBtnsRow = document.createElement('div');
        bgBtnsRow.style.cssText = 'display: flex; gap: 8px; padding: 4px 8px 8px 8px;';
        bgBtnsRow.innerHTML = `
            <div id="addon-bg-upload" style="flex: 1; padding: 6px 12px; cursor: pointer; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 13px; font-weight: 500; color: #334155; text-align: center; transition: background 0.2s; background-color: transparent;">Загрузить фон</div>
            <div id="addon-bg-reset" style="padding: 6px 12px; cursor: pointer; border-radius: 6px; border: 1px solid #fca5a5; font-size: 13px; font-weight: bold; color: #dc2626; background: #fff1f2; text-align: center; transition: background 0.2s;" title="Сбросить фон">×</div>
            <input type="file" id="addon-bg-file" accept="image/*" style="display: none;">
        `;
        bgBtnsRow.onclick = (e) => e.stopPropagation();
        bgSection.appendChild(bgBtnsRow);

        const uploadBtn = bgBtnsRow.querySelector('#addon-bg-upload');
        const resetBtn = bgBtnsRow.querySelector('#addon-bg-reset');
        const fileInput = bgBtnsRow.querySelector('#addon-bg-file');

        uploadBtn.onmouseenter = () => uploadBtn.style.backgroundColor = '#f1f5f9';
        uploadBtn.onmouseleave = () => uploadBtn.style.backgroundColor = 'transparent';
        resetBtn.onmouseenter = () => resetBtn.style.backgroundColor = '#fee2e2';
        resetBtn.onmouseleave = () => resetBtn.style.backgroundColor = '#fff1f2';

        uploadBtn.onclick = () => fileInput.click();
        resetBtn.onclick = () => { localStorage.removeItem('addon_background'); applyCustomBackground(); };

        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file || !file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    let w = img.width, h = img.height;
                    if (w > 1920) { h *= 1920 / w; w = 1920; }
                    canvas.width = w; canvas.height = h;
                    ctx.drawImage(img, 0, 0, w, h);
                    try {
                        localStorage.setItem('addon_background', canvas.toDataURL('image/jpeg', 0.8));
                        applyCustomBackground();
                    } catch (err) { alert('Ошибка: файл слишком большой.'); }
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
            fileInput.value = '';
        };

        //прозрачность фона
        const currentOpacity = localStorage.getItem('addon_bg_opacity') || '0.3';
        const opacityRow = document.createElement('div');
        opacityRow.style.cssText = 'padding: 8px; display: flex; flex-direction: column; gap: 8px;';
        opacityRow.innerHTML = `
            <div style="font-size: 13px; font-weight: 400; color: #334155; display: flex; justify-content: space-between;">
                <span>Прозрачность слоя</span>
                <span id="addon-opacity-val">${Math.round(currentOpacity * 100)}%</span>
            </div>
            <input type="range" id="addon-opacity-slider" min="0" max="1" step="0.05" value="${currentOpacity}" style="width: 100%; cursor: pointer; margin: 0;">
        `;
        opacityRow.onclick = (e) => e.stopPropagation();

        const slider = opacityRow.querySelector('#addon-opacity-slider');
        const valDisplay = opacityRow.querySelector('#addon-opacity-val');
        slider.oninput = (e) => {
            valDisplay.textContent = Math.round(e.target.value * 100) + '%';
            localStorage.setItem('addon_bg_opacity', e.target.value);
            applyCustomBackground();
        };
        bgSection.appendChild(opacityRow);

        //статичный фон
        bgSection.appendChild(createSmartToggle('Зафиксировать фон', null, 'addon_bg_attachment', (val) => {
            localStorage.setItem('addon_bg_attachment', val ? 'fixed' : 'scroll');
            applyCustomBackground();
        }));

        customDropdown.appendChild(bgSection);

        // ==========================================
        // ИТОГОВАЯ СБОРКА
        // ==========================================

        settingsMenu.style.position = 'relative';
        settingsMenu.appendChild(customDropdown);

        settingsLink.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            customDropdown.style.display = customDropdown.style.display === 'flex' ? 'none' : 'flex';
            if (oldContainer) oldContainer.style.display = 'none';
        }, true);

        document.addEventListener('click', (e) => {
            if (!settingsMenu.contains(e.target)) customDropdown.style.display = 'none';
        });

        // Запрещаем кликам закрывать меню
        customDropdown.addEventListener('click', (e) => e.stopPropagation());

        if (oldContainer) {
            oldContainer.style.display = 'none';
            const hideObserver = new MutationObserver(() => {
                if (oldContainer.style.display !== 'none') oldContainer.style.display = 'none';
            });
            hideObserver.observe(oldContainer, { attributes: true, attributeFilter: ['style'] });
        }
    }








    // =================================================================================
    // ГИТ
    // =================================================================================

    function getGitProjectsStorageKey() {
        const projectSpan = document.querySelector('.current-project');
        const projectName = projectSpan ? projectSpan.textContent.trim().replace(/[^a-zA-Zа-яА-Я0-9]/g, '_') : 'global';
        return 'addon_git_projects_' + projectName;
    }

    function getGitProjects() {
        return JSON.parse(localStorage.getItem(getGitProjectsStorageKey()) || '[]');
    }

    function saveGitProjects(projects) {
        localStorage.setItem(getGitProjectsStorageKey(), JSON.stringify(projects));
    }

    function openGitSettingsModal() {
        let overlay = document.getElementById('addon-git-overlay');
        let modal = document.getElementById('addon-git-modal');

        if (!document.getElementById('addon-git-dnd-styles')) {
            const style = document.createElement('style');
            style.id = 'addon-git-dnd-styles';
            style.textContent = `
                .addon-git-row { cursor: grab; }
                .addon-git-row:active { cursor: grabbing; }
                /* Заглушка, которая раздвигает элементы */
                .git-dnd-placeholder {
                    background: rgba(59, 130, 246, 0.05) !important;
                    border: 2px dashed #3b82f6 !important;
                    border-radius: 8px !important;
                    box-sizing: border-box !important;
                    flex-shrink: 0 !important;
                }
                /* Прячем баг браузера, который может подсвечивать текст при перетаскивании */
                .addon-git-row * { pointer-events: none; }
                .addon-git-row .addon-git-toggle-del { pointer-events: auto; }
            `;
            document.head.appendChild(style);
        }

        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'addon-git-overlay';
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.4); z-index: 10005; backdrop-filter: blur(3px); opacity: 0; transition: opacity 0.2s;';
            document.body.appendChild(overlay);

            modal = document.createElement('div');
            modal.id = 'addon-git-modal';
            modal.style.cssText = `
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95);
                background: #fff; width: 450px; max-height: 80vh; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.3);
                z-index: 10006; font-family: 'Inter', sans-serif; display: flex; flex-direction: column;
                opacity: 0; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); overflow: hidden;
            `;
            document.body.appendChild(modal);

            overlay.addEventListener('click', closeGitModal);
        }

        function applyGitDeletions() {
            let currentProjects = getGitProjects();
            if (!modal) return currentProjects;

            const rows = modal.querySelectorAll('.addon-git-row');
            const indicesToDelete = [];

            rows.forEach(row => {
                if (row.getAttribute('data-marked-delete') === 'true') {
                    indicesToDelete.push(parseInt(row.getAttribute('data-index'), 10));
                }
            });

            if (indicesToDelete.length > 0) {
                currentProjects = currentProjects.filter((_, i) => !indicesToDelete.includes(i));
                saveGitProjects(currentProjects);
            }
            return currentProjects;
        }

        function closeGitModal() {
            applyGitDeletions();
            overlay.style.opacity = '0';
            modal.style.opacity = '0';
            modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
            setTimeout(() => { overlay.style.display = 'none'; modal.style.display = 'none'; }, 200);
        }

        function renderModalContent() {
            const projects = getGitProjects();
            const lastPrefix = localStorage.getItem('addon_git_last_prefix') || '';

            const iconTrash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
            const iconRestore = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
            const iconGrip = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>`;

            modal.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
                    <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #0f172a;">Настройки GIT</h3>
                    <svg id="addon-git-close" style="cursor: pointer; color: #64748b; transition: color 0.2s;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </div>
                <div style="padding: 20px; display: flex; flex-direction: column; gap: 16px; flex-grow: 1; min-height: 0; overflow: hidden;">
                    <div id="addon-git-list" style="display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding-right: 4px;">
                       ${projects.length === 0 ? `
                            <div style="color: #475569; font-size: 13px; line-height: 1.5; padding: 16px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px;">
                                <div style="font-weight: 600; color: #0f172a; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; font-size: 14px;">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                                    Интеграция с GIT
                                </div>

                                <div style="margin-bottom: 14px;">
                                    Интеграция предназначена для быстрой генерации черновиков Issue. Скрипт формирует специальную ссылку на выбранный репозиторий и автоматически передает в неё номер и название текущей задачи из Redmine, полностью исключая ручное копирование данных.
                                </div>

                                <div style="margin-bottom: 14px;">
                                    <b>1. Первичная настройка:</b><br>
                                    Для начала добавьте все репозитории, которые относятся к этому проекту. Для каждого из репозиториев заполните три параметра в форме ниже:
                                    <ul style="margin: 6px 0 0 0; padding-left: 20px;">
                                        <li style="margin-bottom: 6px;"><b>Примечание:</b> понятное имя (например, <i>Backend</i> или <i>Frontend</i>, если репозиториев несколько). Помогает быстро отличить репозитории друг от друга в меню выбора.</li>
                                        <li style="margin-bottom: 6px;"><b>Префикс:</b> текст, который подставляется перед номером задачи.
                                            <ul style="margin: 4px 0 0 0; padding-left: 16px; list-style-type: circle; color: #64748b;">
                                                <li><i>Пример:</i> если указать префикс <code>R-</code>, а номер задачи <code>12345</code>, в заголовок Git передастся <code>R-12345</code>.</li>
                                                <li><i>Особенность:</i> система запоминает последний введенный префикс и подставляет его для новых проектов. Если префикс не нужен, оставьте поле пустым.</li>
                                            </ul>
                                        </li>
                                        <li><b>URL репозитория:</b> прямая ссылка на репозиторий.</li>
                                    </ul>
                                </div>

                                <div style="margin-bottom: 14px;">
                                    <b>2. Управление списком:</b><br>
                                    <ul style="margin: 6px 0 0 0; padding-left: 20px; color: #64748b;">
                                        <li style="margin-bottom: 4px;"><i>Сортировка:</i> зажмите иконку (шесть точек) слева от добавленного репозитория и перетащите его выше или ниже. В таком же порядке репозитории будут отображаться в меню при создании Issue.</li>
                                        <li><i>Удаление:</i> при нажатии на корзину репозиторий помечается на удаление (тускнеет) с возможностью восстановления. Фактическое удаление произойдет только при закрытии этого окна или добавлении нового репозитория.</li>
                                    </ul>
                                </div>

                                <div>
                                    <b>3. Как использовать:</b><br>
                                    <ol style="margin: 6px 0 0 0; padding-left: 20px;">
                                        <li style="margin-bottom: 4px;">Добавьте все репозитории, которые вы будете использовать для этого проекта.</li>
                                        <li style="margin-bottom: 4px;">Кликните правой кнопкой мыши по карточке задачи на доске, чтобы открыть контекстное меню.</li>
                                        <li style="margin-bottom: 4px;">Выберите <b>«Создать issue»</b>.</li>
                                        <li>Если добавлен один репозиторий - в браузере сразу откроется новая вкладка с черновиком issue. Если репозиториев несколько - дополнительно появится окно для выбора репозитория.</li>
                                    </ol>
                                </div>
                            </div>
                        ` :
                          projects.map((p, i) => `
                            <div class="addon-git-row" draggable="true" data-index="${i}" data-marked-delete="false" style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; padding: 8px 10px; border-radius: 8px; border: 1px solid #e2e8f0; flex-shrink: 0; transition: opacity 0.2s, background-color 0.2s;">
                                <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; flex-grow: 1;">
                                    <div class="git-drag-handle" style="cursor: grab; display: flex; align-items: center; justify-content: center; padding: 4px; pointer-events: auto;">
                                        ${iconGrip}
                                    </div>
                                    <div style="display: flex; flex-direction: column; overflow: hidden;">
                                        <span style="font-weight: 600; font-size: 13px; color: #334155;">${p.note} <span style="color: #94a3b8; font-weight: normal; font-size: 11px;">(${p.prefix ? p.prefix : 'без префикса'})</span></span>
                                        <span style="font-size: 11px; color: #64748b; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;" title="${p.url}">${p.url}</span>
                                    </div>
                                </div>
                                <div class="addon-git-toggle-del" style="cursor: pointer; color: #ef4444; padding: 4px; border-radius: 4px; flex-shrink: 0; transition: all 0.2s;" title="Удалить">
                                    ${iconTrash}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <div style="height: 1px; background: #e2e8f0; flex-shrink: 0;"></div>
                    <div style="display: flex; flex-direction: column; gap: 12px; flex-shrink: 0;">
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="addon-git-note" placeholder="Примечание" style="flex: 2; box-sizing: border-box; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; outline: none; transition: border-color 0.2s;">
                            <input type="text" id="addon-git-prefix" value="${lastPrefix}" placeholder="Префикс" style="flex: 1.2; box-sizing: border-box; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; outline: none; transition: border-color 0.2s;">
                        </div>
                        <input type="text" id="addon-git-url" placeholder="URL репозитория" style="width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; outline: none; transition: border-color 0.2s;">
                        <input type="button" id="addon-git-add" value="Добавить репозиторий" style="-webkit-appearance: none !important; appearance: none !important; display: flex !important; align-items: center !important; justify-content: center !important; width: 100% !important; margin: 0 !important; padding: 8px !important; border-radius: 6px !important; background-color: #2563eb !important; color: #ffffff !important; border: none !important; box-shadow: none !important; text-shadow: none !important; font-family: 'Inter', sans-serif !important; font-size: 13px !important; font-weight: 600 !important; text-transform: none !important; letter-spacing: normal !important; cursor: pointer !important; transition: background-color 0.2s !important; height: auto !important; line-height: 1.5 !important;">
                    </div>
                </div>
            `;

            const listContainer = modal.querySelector('#addon-git-list');
            let dragEl = null;
            let placeholder = document.createElement('div');
            placeholder.className = 'git-dnd-placeholder';

            if (listContainer) {
                listContainer.addEventListener('dragover', function(e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';

                    if (!dragEl) return;

                    const afterElement = getDragAfterElement(listContainer, e.clientY);
                    if (afterElement == null) {
                        listContainer.appendChild(placeholder);
                    } else {
                        listContainer.insertBefore(placeholder, afterElement);
                    }
                });

                function getDragAfterElement(container, y) {
                    const draggableElements = [...container.querySelectorAll('.addon-git-row:not(.is-dragging)')];
                    return draggableElements.reduce((closest, child) => {
                        const box = child.getBoundingClientRect();
                        const offset = y - box.top - box.height / 2;
                        if (offset < 0 && offset > closest.offset) {
                            return { offset: offset, element: child };
                        } else {
                            return closest;
                        }
                    }, { offset: Number.NEGATIVE_INFINITY }).element;
                }
            }

            modal.querySelectorAll('.addon-git-row').forEach(row => {
                const btn = row.querySelector('.addon-git-toggle-del');

                // выбираем на удаление
                btn.onmouseenter = () => {
                    const isMarked = row.getAttribute('data-marked-delete') === 'true';
                    btn.style.backgroundColor = isMarked ? '#dcfce7' : '#fee2e2';
                };
                btn.onmouseleave = () => {
                    btn.style.backgroundColor = 'transparent';
                };

                btn.onclick = () => {
                    const isMarked = row.getAttribute('data-marked-delete') === 'true';
                    if (!isMarked) {
                        row.setAttribute('data-marked-delete', 'true');
                        row.style.opacity = '0.4';
                        btn.style.color = '#16a34a';
                        btn.title = 'Восстановить';
                        btn.innerHTML = iconRestore;
                        btn.style.backgroundColor = '#dcfce7';
                    } else {
                        row.setAttribute('data-marked-delete', 'false');
                        row.style.opacity = '1';
                        btn.style.color = '#ef4444';
                        btn.title = 'Удалить';
                        btn.innerHTML = iconTrash;
                        btn.style.backgroundColor = '#fee2e2';
                    }
                    btn.style.transform = 'scale(1.2)';
                    setTimeout(() => btn.style.transform = 'scale(1)', 150);
                };

                //сортировка, чтобы можно было таскать за объект
                row.addEventListener('dragstart', function(e) {
                    dragEl = this;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/html', this.innerHTML);

                    placeholder.style.height = this.offsetHeight + 'px';

                    setTimeout(() => {
                        this.classList.add('is-dragging');
                        this.style.display = 'none';
                        if (this.parentNode) {
                            this.parentNode.insertBefore(placeholder, this.nextSibling);
                        }
                    }, 0);
                });

                row.addEventListener('dragend', function(e) {
                    this.classList.remove('is-dragging');
                    this.style.display = 'flex';

                    // вставляем карточку на место плейсхолдера
                    if (placeholder.parentNode) {
                        placeholder.parentNode.insertBefore(this, placeholder);
                        placeholder.parentNode.removeChild(placeholder);
                    }
                    dragEl = null;

                    //обновляем массив в памяти БЕЗ перерисовки
                    const currentProjects = getGitProjects();
                    const newProjects = [];
                    const allRows = listContainer.querySelectorAll('.addon-git-row');

                    allRows.forEach((r, newIdx) => {
                        const oldIdx = parseInt(r.getAttribute('data-index'), 10);
                        newProjects.push(currentProjects[oldIdx]);
                        r.setAttribute('data-index', newIdx);
                    });

                    saveGitProjects(newProjects);
                });
            });

            //подсветка инпутов
            ['addon-git-note', 'addon-git-prefix', 'addon-git-url'].forEach(id => {
                const el = modal.querySelector('#' + id);
                el.onfocus = () => el.style.borderColor = '#3b82f6';
                el.onblur = () => el.style.borderColor = '#cbd5e1';
            });

            const closeBtn = modal.querySelector('#addon-git-close');
            closeBtn.onmouseenter = () => closeBtn.style.color = '#0f172a';
            closeBtn.onmouseleave = () => closeBtn.style.color = '#64748b';
            closeBtn.onclick = closeGitModal;

            //логика добавления репы
            modal.querySelector('#addon-git-add').onclick = () => {
                const noteInput = modal.querySelector('#addon-git-note');
                const prefixInput = modal.querySelector('#addon-git-prefix');
                const urlInput = modal.querySelector('#addon-git-url');

                const note = noteInput.value.trim();
                const prefix = prefixInput.value.trim();
                let url = urlInput.value.trim();

                if (!note || !url) {
                    alert('Заполните примечание и URL проекта!');
                    return;
                }

                if (url.endsWith('/')) url = url.slice(0, -1);

                localStorage.setItem('addon_git_last_prefix', prefix);

                let currentProjects = applyGitDeletions();

                currentProjects.push({ note, url, prefix });
                saveGitProjects(currentProjects);

                renderModalContent();
            };
        }

        renderModalContent();

        overlay.style.display = 'block';
        modal.style.display = 'flex';
        // Анимация появления
        setTimeout(() => {
            overlay.style.opacity = '1';
            modal.style.opacity = '1';
            modal.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 10);
    }






    // =================================================================================
    // ГОРЯЧИЕ КЛАВИШИ
    // =================================================================================

    function initFullscreenHotkey() {
        //защита от двойного навешивания события при авто-рефреше доски
        if (window.addonFullscreenHotkeyInitialized) return;
        window.addonFullscreenHotkeyInitialized = true;

        document.addEventListener('keydown', (e) => {
            //проверяем, не печатает ли текст в данный момент
            const activeEl = document.activeElement;
            if (activeEl) {
                const tag = activeEl.tagName.toLowerCase();
                //если курсор стоит в инпуте, текстарее или любом редактируемом поле - игнорируем
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || activeEl.isContentEditable) {
                    return;
                }
            }

            //f или а русская не важно
            if (e.code === 'KeyF' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault(); //блокируем стандартное поведение браузера

                //дергаем функцию
                if (typeof window.toggleAddonFullscreen === 'function') {
                    window.toggleAddonFullscreen();
                }
            }
        });
    }






    // =================================================================================
    // дедлайны попапы
    // =================================================================================

    function initDeadlineTooltip() {
        if (!document.getElementById('addon-tooltip-styles')) {
            const style = document.createElement('style');
            style.id = 'addon-tooltip-styles';
            style.textContent = `
                /* Меняем курсор на знак вопроса только при наведении на дедлайн */
                .rdb-deadline-badge { cursor: help !important; }

                /* Стили независимого всплывающего окна */
                #addon-deadline-popup {
                    position: absolute;
                    z-index: 10005;
                    background: #fff;
                    border: 1px solid #e2e8f0;
                    border-radius: 6px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                    padding: 6px 12px;
                    font-family: 'Inter', sans-serif;
                    font-size: 13px;
                    pointer-events: none; /* Окно прозрачно для мыши, чтобы не глючило при наведении */
                    display: none;
                    white-space: nowrap;
                }
            `;
            document.head.appendChild(style);
        }

        let popup = document.getElementById('addon-deadline-popup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'addon-deadline-popup';
            document.body.appendChild(popup);
        }

        //перестеч рабочих дней (выкидываем сб=6 и вс=0)
        function getWorkingDays(start, end) {
            let count = 0;
            let cur = new Date(start);
            cur.setHours(0,0,0,0);
            const endDate = new Date(end);
            endDate.setHours(0,0,0,0);

            while (cur <= endDate) {
                const day = cur.getDay();
                if (day !== 0 && day !== 6) count++;
                cur.setDate(cur.getDate() + 1);
            }
            return count;
        }

        //глобавльно
        if (!window.addonTooltipHooked) {
            window.addonTooltipHooked = true;

            document.addEventListener('mouseover', (e) => {
                const badge = e.target.closest('.rdb-deadline-badge');
                if (!badge) return;

                const text = badge.textContent.trim();
                const match = text.match(/(Deadline:|до)\s*(\d{2})\.(\d{2})\.(\d{4})/i);
                if (!match) return;

                const d = parseInt(match[2], 10);
                const m = parseInt(match[3], 10) - 1;//чтобы месяцы правильно считались, надо с 0 а не с 1
                const y = parseInt(match[4], 10);

                const deadlineDate = new Date(y, m, d);
                deadlineDate.setHours(0,0,0,0);

                const today = new Date();
                today.setHours(0,0,0,0);

                let infoText = '';
                let infoColor = '#0f172a';

                if (deadlineDate.getTime() === today.getTime()) {
                    infoText = 'Дедлайн сегодня!';
                    infoColor = '#f97316'; //оранжевый
                } else if (deadlineDate > today) {
                    const nextDay = new Date(today);
                    nextDay.setDate(nextDay.getDate() + 1);
                    const wDays = getWorkingDays(nextDay, deadlineDate);

                    if (wDays > 3) {
                        infoText = `В запасе: ${wDays} раб. дн.`;
                        infoColor = '#16a34a'; //зеленый
                    } else {
                        infoText = `Осталось: ${wDays} раб. дн.`;
                        infoColor = '#f97316'; //оранжевый
                    }
                } else {
                    const nextDayAfterDeadline = new Date(deadlineDate);
                    nextDayAfterDeadline.setDate(nextDayAfterDeadline.getDate() + 1);
                    const wDays = getWorkingDays(nextDayAfterDeadline, today);
                    infoText = `Просрочено: ${wDays} раб. дн.`;
                    infoColor = '#e11d48'; //красный
                }

                popup.innerHTML = `<span style="color: ${infoColor}; font-weight: 600;">${infoText}</span>`;

                //отображаем, чтобы получить размеры
                popup.style.display = 'block';

                const rect = badge.getBoundingClientRect();
                let topPos = rect.top + window.scrollY - popup.offsetHeight - 8;
                let leftPos = rect.left + window.scrollX + (rect.width / 2) - (popup.offsetWidth / 2);

                //если попап вылезает за верхний край экрана - показываем его снизу
                if (topPos < window.scrollY) {
                    topPos = rect.bottom + window.scrollY + 8;
                }

                popup.style.top = topPos + 'px';
                popup.style.left = leftPos + 'px';
            });

            //прячем попап, когда убираем мышку
            document.addEventListener('mouseout', (e) => {
                if (e.target.closest('.rdb-deadline-badge')) {
                    popup.style.display = 'none';
                }
            });
        }
    }




    function injectDynamicPriorityStyles() {
        const styleId = 'addon-dynamic-priorities';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;

        let css = '';
        PRIORITIES_CONFIG.forEach(p => {
            css += `.${p.id} { border-color: ${p.color} !important; }\n`;
        });

        style.textContent = css;
        document.head.appendChild(style);
    }



    // =================================================================================
    // КНОПКА "НАВЕРХ"
    // =================================================================================
    function injectBackToTopButton() {
        if (document.getElementById('addon-back-to-top')) return;

        // Внедряем стили для плавной анимации появления и ховера
        const styleId = 'addon-btt-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                #addon-back-to-top {
                    position: fixed;
                    bottom: 30px;
                    right: 30px;
                    width: 44px;
                    height: 44px;
                    background-color: #2563eb;
                    color: #ffffff;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
                    z-index: 10000;
                    opacity: 0;
                    visibility: hidden;
                    transform: translateY(20px);
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                }
                #addon-back-to-top.show {
                    opacity: 1;
                    visibility: visible;
                    transform: translateY(0);
                }
                #addon-back-to-top:hover {
                    background-color: #1d4ed8;
                    transform: translateY(-3px) scale(1.05) !important;
                    box-shadow: 0 6px 16px rgba(37, 99, 235, 0.5);
                }
            `;
            document.head.appendChild(style);
        }

        // Создаем саму кнопку
        const btn = document.createElement('div');
        btn.id = 'addon-back-to-top';
        btn.title = 'Наверх';
        btn.innerHTML = `
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"></line>
                <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
        `;

        // Плавный скролл наверх
        btn.onclick = () => {
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        };

        document.body.appendChild(btn);

        // Отслеживаем скролл для показа/скрытия кнопки
        window.addEventListener('scroll', () => {
            if (window.scrollY > 300) {
                btn.classList.add('show');
            } else {
                btn.classList.remove('show');
            }
        });
    }




    function runAllLogic() {
        applyCustomBackground();
        initUI();

        injectNewCardCSS(); // НОВАЯ СТРОКА: загружаем стили для новой карточки

        // СНАЧАЛА подготавливаем все карточки
        applyEnhancements();
        injectDynamicPriorityStyles();
        sortIssues();

        // ПОТОМ генерируем интерфейс
        injectCustomFilters();
        injectCreateButton();
        enhanceSettingsMenu();
        injectFavoriteMenu();
        enhanceAssigneeMenu();
        injectBackToTopButton();

        updateStars = initFavoriteStars();
        initContextMenu(updateStars);

        initFullscreenHotkey();
        initDeadlineTooltip();

        parseAndTransformTable('issue_tree', 'addon-subtasks-list');
        parseAndTransformTable('relations', 'addon-relations-list');
        if (document.getElementById('addon-subtasks-list') || document.getElementById('addon-relations-list')) {
            document.body.classList.add('addon-tables-ready');
        }
    }

    runAllLogic();

    const observer = new MutationObserver(() => {
        observer.disconnect();
        runAllLogic();
        if (updateStars) updateStars();
        observer.observe(document.body, { childList: true, subtree: true });
    });



    observer.observe(document.body, { childList: true, subtree: true });

})();