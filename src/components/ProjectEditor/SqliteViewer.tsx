/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import type {
  ProjectSqliteExecuteResult,
  SqliteColumnInfo,
  SqliteRow,
  SqliteRowKey,
  SqliteTableInfo,
  SqliteValue
} from '../../types/electron'

const DEFAULT_PAGE_SIZE = 100
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const
const DEFAULT_SQL_INPUT = 'SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name;'

type StatusMessage = {
  type: 'success' | 'error' | 'pending'
  text: string
}

interface SqliteViewerProps {
  rootPath: string
  filePath: string
  onNotifyGitChange?: () => void
}

function makeRowKeyId(key: SqliteRowKey): string {
  if (key.kind === 'rowid') {
    return `rowid:${key.rowid}`
  }
  const orderedKeys = Object.keys(key.values).sort((a, b) => a.localeCompare(b))
  const values = orderedKeys.map((column) => `${column}=${String(key.values[column])}`).join('&')
  return `pk:${values}`
}

function isBlobColumn(column: SqliteColumnInfo): boolean {
  return /BLOB/i.test(column.type || '')
}

function isNumericColumn(column: SqliteColumnInfo): boolean {
  return /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/i.test(column.type || '')
}

function stringifySqliteValue(value: SqliteValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return `<BLOB ${value.bytes} bytes>`
}

function renderSqliteValue(value: SqliteValue): string {
  if (value === null) return '(NULL)'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return `<BLOB ${value.bytes} bytes>`
}

function normalizeInputValue(column: SqliteColumnInfo, raw: string): string | number | null {
  const trimmed = raw.trim()
  if (trimmed.toUpperCase() === 'NULL') return null
  if (isNumericColumn(column) && /^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return raw
}

function toTestIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function SqliteViewer({ rootPath, filePath, onNotifyGitChange }: SqliteViewerProps) {
  const { t } = useI18n()

  // Product telemetry: count once per SQLite viewer open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('sqlite-viewer') }, [])

  const [tables, setTables] = useState<SqliteTableInfo[]>([])
  const [activeTable, setActiveTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<SqliteColumnInfo[]>([])
  const [rows, setRows] = useState<SqliteRow[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [jumpPageInput, setJumpPageInput] = useState('1')
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [editingEnabled, setEditingEnabled] = useState(false)
  const [editingRowId, setEditingRowId] = useState<string | null>(null)
  const [rowDraft, setRowDraft] = useState<Record<string, string>>({})
  const [insertMode, setInsertMode] = useState(false)
  const [insertDraft, setInsertDraft] = useState<Record<string, string>>({})
  const [sqlConsoleVisible, setSqlConsoleVisible] = useState(false)
  const [sqlInput, setSqlInput] = useState(DEFAULT_SQL_INPUT)
  const [sqlRunning, setSqlRunning] = useState(false)
  const [sqlResult, setSqlResult] = useState<ProjectSqliteExecuteResult | null>(null)
  const [sqlResultHidden, setSqlResultHidden] = useState(false)
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null)
  const sourceKeyRef = useRef(`${rootPath}::${filePath}`)
  const schemaRequestTokenRef = useRef(0)
  const rowsRequestTokenRef = useRef(0)

  const activeTableInfo = useMemo(() => {
    if (!activeTable) return null
    return tables.find(table => table.name === activeTable) ?? null
  }, [activeTable, tables])

  const totalPages = useMemo(() => {
    const pageCount = Math.ceil(totalRows / pageSize)
    return Math.max(1, pageCount || 1)
  }, [pageSize, totalRows])

  const currentPage = useMemo(() => {
    return Math.floor(offset / pageSize) + 1
  }, [offset, pageSize])

  useEffect(() => {
    setJumpPageInput(String(currentPage))
  }, [currentPage])

  const showStatus = useCallback((type: StatusMessage['type'], text: string) => {
    setStatusMessage({ type, text })
  }, [])

  const loadSchema = useCallback(async (preferredTable?: string | null) => {
    const requestToken = schemaRequestTokenRef.current + 1
    schemaRequestTokenRef.current = requestToken
    setSchemaLoading(true)
    const requestSourceKey = `${rootPath}::${filePath}`
    const result = await window.electronAPI.project.sqliteGetSchema(rootPath, filePath)
    if (requestToken !== schemaRequestTokenRef.current || requestSourceKey !== sourceKeyRef.current) {
      return null
    }
    setSchemaLoading(false)

    if (!result.success) {
      setTables([])
      setActiveTable(null)
      setColumns([])
      setRows([])
      setTotalRows(0)
      showStatus('error', result.error || t('sqliteViewer.status.readSchemaError'))
      return null
    }

    setTables(result.tables)
    if (result.tables.length === 0) {
      setActiveTable(null)
      setColumns([])
      setRows([])
      setTotalRows(0)
      showStatus('pending', t('sqliteViewer.status.noTables'))
      return null
    }

    const nextTable =
      (preferredTable && result.tables.some(table => table.name === preferredTable) ? preferredTable : null) ||
      result.tables[0]?.name ||
      null

    setActiveTable(nextTable)
    return nextTable
  }, [filePath, rootPath, showStatus, t])

  const loadRows = useCallback(async (tableName: string, nextOffset = 0, limit = pageSize) => {
    const requestToken = rowsRequestTokenRef.current + 1
    rowsRequestTokenRef.current = requestToken
    setRowsLoading(true)
    const requestSourceKey = `${rootPath}::${filePath}`
    const safeOffset = Math.max(0, Math.floor(nextOffset))
    const safeLimit = Math.max(1, Math.floor(limit))

    const result = await window.electronAPI.project.sqliteReadTableRows(
      rootPath,
      filePath,
      tableName,
      safeLimit,
      safeOffset
    )

    if (requestToken !== rowsRequestTokenRef.current || requestSourceKey !== sourceKeyRef.current) {
      return false
    }
    setRowsLoading(false)

    if (!result.success) {
      if ((result.error || '').includes('Table does not exist')) {
        // While switching database files, the previous table name may briefly become invalid.
        const nextTable = await loadSchema(null)
        if (nextTable) {
          return await loadRows(nextTable, 0, safeLimit)
        }
        return false
      }
      setColumns([])
      setRows([])
      setTotalRows(0)
      showStatus('error', result.error || t('sqliteViewer.status.readRowsError'))
      return false
    }

    setColumns(result.columns)
    setRows(result.rows)
    setTotalRows(result.totalRows)
    setOffset(result.offset)
    return true
  }, [filePath, loadSchema, pageSize, rootPath, showStatus, t])

  const refreshTable = useCallback(async (preferredTable?: string | null, preferredOffset = 0, preferredLimit = pageSize) => {
    const resolvedTable = await loadSchema(preferredTable)
    if (!resolvedTable) return false
    return await loadRows(resolvedTable, preferredOffset, preferredLimit)
  }, [loadRows, loadSchema, pageSize])

  useEffect(() => {
    sourceKeyRef.current = `${rootPath}::${filePath}`
    schemaRequestTokenRef.current += 1
    rowsRequestTokenRef.current += 1
    setTables([])
    setActiveTable(null)
    setColumns([])
    setRows([])
    setTotalRows(0)
    setOffset(0)
    setPageSize(DEFAULT_PAGE_SIZE)
    setJumpPageInput('1')
    setEditingEnabled(false)
    setEditingRowId(null)
    setRowDraft({})
    setInsertMode(false)
    setInsertDraft({})
    setSqlConsoleVisible(false)
    setSqlInput(DEFAULT_SQL_INPUT)
    setSqlResult(null)
    setSqlResultHidden(false)
    setStatusMessage(null)
    void refreshTable(null, 0, DEFAULT_PAGE_SIZE)
  }, [filePath, refreshTable, rootPath])

  useEffect(() => {
    if (!activeTable) return
    if (!tables.some(table => table.name === activeTable)) return
    void loadRows(activeTable, 0, pageSize)
  }, [activeTable, loadRows, pageSize, tables])

  const canPrevPage = offset > 0
  const canNextPage = offset + pageSize < totalRows

  const handleRefresh = useCallback(async () => {
    showStatus('pending', t('sqliteViewer.status.refreshing'))
    const ok = await refreshTable(activeTable, offset, pageSize)
    if (ok) {
      showStatus('success', t('sqliteViewer.status.refreshed'))
    }
  }, [activeTable, offset, pageSize, refreshTable, showStatus, t])

  const handleToggleEditing = useCallback(() => {
    setEditingEnabled((prev) => {
      const next = !prev
      if (!next) {
        setEditingRowId(null)
        setInsertMode(false)
        setRowDraft({})
        setInsertDraft({})
      }
      showStatus('success', next ? t('sqliteViewer.status.editModeEnabled') : t('sqliteViewer.status.readOnlyMode'))
      return next
    })
  }, [showStatus, t])

  const handleBeginEditRow = useCallback((row: SqliteRow) => {
    const nextDraft: Record<string, string> = {}
    for (const column of columns) {
      nextDraft[column.name] = stringifySqliteValue(row.values[column.name] ?? null)
    }
    setEditingRowId(makeRowKeyId(row.key))
    setRowDraft(nextDraft)
  }, [columns])

  const handleCancelEditRow = useCallback(() => {
    setEditingRowId(null)
    setRowDraft({})
  }, [])

  const handleSaveRow = useCallback(async (row: SqliteRow) => {
    if (!activeTable || !editingEnabled) return
    const payload: Record<string, unknown> = {}
    for (const column of columns) {
      if (isBlobColumn(column)) continue
      payload[column.name] = normalizeInputValue(column, rowDraft[column.name] ?? '')
    }
    const result = await window.electronAPI.project.sqliteUpdateRow(rootPath, filePath, activeTable, row.key, payload)
    if (!result.success) {
      showStatus('error', result.error || t('sqliteViewer.status.updateError'))
      return
    }

    setEditingRowId(null)
    setRowDraft({})
    showStatus('success', t('sqliteViewer.status.updatedRows', { count: result.changes }))
    await loadRows(activeTable, offset, pageSize)
    void loadSchema(activeTable)
    onNotifyGitChange?.()
  }, [activeTable, columns, editingEnabled, filePath, loadRows, loadSchema, offset, onNotifyGitChange, pageSize, rootPath, rowDraft, showStatus, t])

  const handleDeleteRow = useCallback(async (row: SqliteRow) => {
    if (!activeTable || !editingEnabled) return
    const confirmed = window.confirm(t('sqliteViewer.confirm.deleteRow'))
    if (!confirmed) return
    const result = await window.electronAPI.project.sqliteDeleteRow(rootPath, filePath, activeTable, row.key)
    if (!result.success) {
      showStatus('error', result.error || t('sqliteViewer.status.deleteError'))
      return
    }

    showStatus('success', t('sqliteViewer.status.deletedRows', { count: result.changes }))
    const adjustedTotal = Math.max(totalRows - Math.max(result.changes, 1), 0)
    const maxValidOffset = Math.max(0, Math.floor((Math.max(adjustedTotal, 1) - 1) / pageSize) * pageSize)
    const nextOffset = Math.min(offset, maxValidOffset)
    await loadRows(activeTable, nextOffset, pageSize)
    void loadSchema(activeTable)
    onNotifyGitChange?.()
  }, [activeTable, editingEnabled, filePath, loadRows, loadSchema, offset, onNotifyGitChange, pageSize, rootPath, showStatus, t, totalRows])

  const handleInsertRow = useCallback(async () => {
    if (!activeTable || !editingEnabled) return
    const payload: Record<string, unknown> = {}
    for (const column of columns) {
      if (isBlobColumn(column)) continue
      const raw = insertDraft[column.name]
      if (raw === undefined || raw.trim() === '') continue
      payload[column.name] = normalizeInputValue(column, raw)
    }
    const result = await window.electronAPI.project.sqliteInsertRow(rootPath, filePath, activeTable, payload)
    if (!result.success) {
      showStatus('error', result.error || t('sqliteViewer.status.insertError'))
      return
    }
    setInsertMode(false)
    setInsertDraft({})
    showStatus('success', t('sqliteViewer.status.insertedRows', { count: result.changes }))
    await loadRows(activeTable, 0, pageSize)
    void loadSchema(activeTable)
    onNotifyGitChange?.()
  }, [activeTable, columns, editingEnabled, filePath, insertDraft, loadRows, loadSchema, onNotifyGitChange, pageSize, rootPath, showStatus, t])

  const handleRunSql = useCallback(async () => {
    const statement = sqlInput.trim()
    if (!statement) {
      showStatus('error', t('sqliteViewer.status.sqlEmpty'))
      return
    }

    const readOnlySql = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(statement)
    if (!editingEnabled && !readOnlySql) {
      showStatus('error', t('sqliteViewer.status.sqlReadonly'))
      return
    }

    setSqlRunning(true)
    const result = await window.electronAPI.project.sqliteExecute(rootPath, filePath, statement)
    setSqlRunning(false)
    setSqlResult(result)
    setSqlResultHidden(false)

    if (!result.success) {
      showStatus('error', result.error || t('sqliteViewer.status.sqlExecuteError'))
      return
    }

    if (result.mode === 'rows') {
      showStatus('success', t('sqliteViewer.status.sqlQuerySuccess', {
        count: result.rows.length,
        suffix: result.truncated ? t('sqliteViewer.sql.truncatedSuffix', { count: result.rows.length }) : '',
      }))
      return
    }

    showStatus('success', t('sqliteViewer.status.sqlExecuteSuccess', {
      count: result.changes,
      rowIdText: result.lastInsertRowid !== null ? t('sqliteViewer.sql.lastInsertRowId', { rowId: result.lastInsertRowid }) : '',
    }))
    await refreshTable(activeTable, offset, pageSize)
    onNotifyGitChange?.()
  }, [activeTable, editingEnabled, filePath, offset, onNotifyGitChange, pageSize, refreshTable, rootPath, showStatus, sqlInput, t])

  const handleSelectTable = useCallback((nextTable: string) => {
    setActiveTable(nextTable)
    setOffset(0)
    setEditingRowId(null)
    setInsertMode(false)
    setRowDraft({})
    setInsertDraft({})
  }, [])

  const handlePageSizeChange = useCallback((nextSize: number) => {
    if (!activeTable) return
    setPageSize(nextSize)
    setOffset(0)
    void loadRows(activeTable, 0, nextSize)
  }, [activeTable, loadRows])

  const handleJumpPage = useCallback(() => {
    if (!activeTable) return
    const nextPage = Math.max(1, Math.min(totalPages, Number.parseInt(jumpPageInput, 10) || 1))
    const nextOffset = (nextPage - 1) * pageSize
    setJumpPageInput(String(nextPage))
    void loadRows(activeTable, nextOffset, pageSize)
  }, [activeTable, jumpPageInput, loadRows, pageSize, totalPages])

  return (
    <div className="project-editor-sqlite" data-testid="sqlite-viewer">
      <div className="project-editor-sqlite-toolbar">
        <div className="project-editor-sqlite-toolbar-group">
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-sql-console-toggle"
            onClick={() => setSqlConsoleVisible((prev) => !prev)}
            disabled={!activeTable}
          >
            {sqlConsoleVisible ? t('sqliteViewer.button.hideSqlConsole') : t('sqliteViewer.button.showSqlConsole')}
          </button>
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-refresh-button"
            onClick={() => void handleRefresh()}
            disabled={schemaLoading || rowsLoading}
          >
            {t('sqliteViewer.button.refresh')}
          </button>
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-edit-toggle"
            onClick={handleToggleEditing}
            disabled={!activeTable}
          >
            {editingEnabled ? t('sqliteViewer.button.exitEditMode') : t('sqliteViewer.button.enterEditMode')}
          </button>
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-add-row-button"
            onClick={() => {
              if (!editingEnabled) return
              setInsertMode((prev) => !prev)
              setInsertDraft({})
            }}
            disabled={!editingEnabled || !activeTable}
          >
            {insertMode ? t('sqliteViewer.button.cancelInsert') : t('sqliteViewer.button.addRow')}
          </button>
        </div>
        <div className="project-editor-sqlite-toolbar-meta">
          {schemaLoading && <span>{t('sqliteViewer.loading.schema')}</span>}
          {rowsLoading && <span>{t('sqliteViewer.loading.rows')}</span>}
          {activeTableInfo && (
            <span>
              {activeTableInfo.hasRowid ? 'rowid' : t('sqliteViewer.primaryKey')} · {t('sqliteViewer.totalRows', { count: totalRows })}
            </span>
          )}
        </div>
      </div>

      {sqlResult && sqlResultHidden && (
        <div className="project-editor-sqlite-sql-result project-editor-sqlite-query-result project-editor-sqlite-query-result-collapsed" data-testid="sqlite-sql-result-collapsed">
          <div className="project-editor-sqlite-sql-meta">
            <span>{t('sqliteViewer.sql.hidden')}</span>
            <button
              className="project-editor-action-btn"
              data-testid="sqlite-result-show"
              onClick={() => setSqlResultHidden(false)}
            >
              {t('sqliteViewer.button.showResult')}
            </button>
          </div>
        </div>
      )}

      {sqlResult && !sqlResultHidden && (
        <div className="project-editor-sqlite-sql-result project-editor-sqlite-query-result" data-testid="sqlite-sql-result">
          <div className="project-editor-sqlite-sql-meta">
            <span>
              {sqlResult.success
                ? (
                  sqlResult.mode === 'rows'
                    ? t('sqliteViewer.sql.querySuccessSummary', {
                      count: sqlResult.rows.length,
                      suffix: sqlResult.truncated ? t('sqliteViewer.sql.truncatedSuffix', { count: sqlResult.rows.length }) : '',
                    })
                    : t('sqliteViewer.sql.executeSuccessSummary', {
                      count: sqlResult.changes,
                      rowIdText: sqlResult.lastInsertRowid !== null ? t('sqliteViewer.sql.lastInsertRowIdColon', { rowId: sqlResult.lastInsertRowid }) : '',
                    })
                )
                : t('sqliteViewer.sql.executeFailureSummary', { error: sqlResult.error || t('sqliteViewer.unknownError') })
              }
            </span>
            <button
              className="project-editor-action-btn"
              data-testid="sqlite-result-hide"
              onClick={() => setSqlResultHidden(true)}
            >
              {t('sqliteViewer.button.hideResult')}
            </button>
          </div>
          {sqlResult.success && sqlResult.mode === 'rows' && sqlResult.columns.length > 0 && (
            <div className="project-editor-sqlite-sql-table-wrap">
              <table className="project-editor-sqlite-table">
                <thead>
                  <tr>
                    {sqlResult.columns.map(column => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sqlResult.rows.map((row, index) => (
                    <tr key={`sql-row-${index}`}>
                      {sqlResult.columns.map(column => (
                        <td key={`${index}-${column}`}>
                          {renderSqliteValue((row[column] ?? null) as SqliteValue)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="project-editor-sqlite-table-grid" data-testid="sqlite-table-grid">
        {tables.map((table) => (
          <button
            key={table.name}
            type="button"
            className={`project-editor-sqlite-table-chip ${activeTable === table.name ? 'active' : ''}`}
            data-testid={`sqlite-table-chip-${toTestIdSegment(table.name)}`}
            onClick={() => handleSelectTable(table.name)}
            disabled={schemaLoading}
            title={t('sqliteViewer.table.title', { name: table.name, count: table.rowCount })}
          >
            <span className="project-editor-sqlite-table-chip-name">{table.name}</span>
            <span className="project-editor-sqlite-table-chip-count">{table.rowCount}</span>
          </button>
        ))}
      </div>

      {statusMessage && (
        <div className={`project-editor-sqlite-status ${statusMessage.type}`} data-testid="sqlite-status">
          {statusMessage.text}
        </div>
      )}

      <div className="project-editor-sqlite-table-wrap">
        <table className="project-editor-sqlite-table" data-testid="sqlite-data-table">
          <thead>
            <tr>
              {columns.map(column => (
                <th key={column.name}>
                  <div className="project-editor-sqlite-column-name">{column.name}</div>
                  <div className="project-editor-sqlite-column-type">{column.type || 'TEXT'}</div>
                </th>
              ))}
              {editingEnabled && activeTable && <th className="project-editor-sqlite-action-col">{t('sqliteViewer.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {insertMode && activeTable && editingEnabled && (
              <tr data-testid="sqlite-insert-row">
                {columns.map(column => {
                  const key = toTestIdSegment(column.name)
                  if (isBlobColumn(column)) {
                    return (
                      <td key={`insert-${column.name}`}>
                        <span className="project-editor-sqlite-cell-readonly">{t('sqliteViewer.blobReadonly')}</span>
                      </td>
                    )
                  }
                  return (
                    <td key={`insert-${column.name}`}>
                      <input
                        data-testid={`sqlite-insert-input-${key}`}
                        value={insertDraft[column.name] ?? ''}
                        onChange={(event) => {
                          const value = event.target.value
                          setInsertDraft((prev) => ({
                            ...prev,
                            [column.name]: value
                          }))
                        }}
                        placeholder={column.hasDefault ? t('sqliteViewer.placeholder.defaultValue') : t('sqliteViewer.placeholder.nullValue')}
                      />
                    </td>
                  )
                })}
                <td className="project-editor-sqlite-row-actions">
                  <button
                    data-testid="sqlite-insert-confirm"
                    className="project-editor-action-btn"
                    onClick={() => void handleInsertRow()}
                  >
                    {t('sqliteViewer.button.insert')}
                  </button>
                  <button
                    className="project-editor-action-btn"
                    onClick={() => {
                      setInsertMode(false)
                      setInsertDraft({})
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                </td>
              </tr>
            )}
            {rows.map((row, rowIndex) => {
              const rowId = makeRowKeyId(row.key)
              const editingThisRow = editingRowId === rowId && editingEnabled
              return (
                <tr key={rowId} data-testid={`sqlite-row-${rowIndex}`}>
                  {columns.map(column => {
                    const key = toTestIdSegment(column.name)
                    const value = row.values[column.name] ?? null
                    if (editingThisRow && !isBlobColumn(column)) {
                      return (
                        <td key={`${rowId}-${column.name}`}>
                          <input
                            data-testid={`sqlite-edit-input-${rowIndex}-${key}`}
                            value={rowDraft[column.name] ?? ''}
                            onChange={(event) => {
                              const nextValue = event.target.value
                              setRowDraft((prev) => ({
                                ...prev,
                                [column.name]: nextValue
                              }))
                            }}
                          />
                        </td>
                      )
                    }

                    return (
                      <td key={`${rowId}-${column.name}`} data-testid={`sqlite-cell-${rowIndex}-${key}`}>
                        {renderSqliteValue(value)}
                      </td>
                    )
                  })}
                  {editingEnabled && (
                    <td className="project-editor-sqlite-row-actions">
                      {editingThisRow ? (
                        <>
                          <button
                            className="project-editor-action-btn"
                            data-testid={`sqlite-save-row-${rowIndex}`}
                            onClick={() => void handleSaveRow(row)}
                          >
                            {t('common.save')}
                          </button>
                          <button className="project-editor-action-btn" onClick={handleCancelEditRow}>
                            {t('common.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          className="project-editor-action-btn"
                          data-testid={`sqlite-edit-row-${rowIndex}`}
                          onClick={() => handleBeginEditRow(row)}
                        >
                          {t('sqliteViewer.button.edit')}
                        </button>
                      )}
                      <button
                        className="project-editor-action-btn danger"
                        data-testid={`sqlite-delete-row-${rowIndex}`}
                        onClick={() => void handleDeleteRow(row)}
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
            {rows.length === 0 && !rowsLoading && (
              <tr>
                <td
                  className="project-editor-sqlite-empty-row"
                  colSpan={columns.length + (editingEnabled && activeTable ? 1 : 0)}
                  data-testid="sqlite-empty"
                >
                  {t('sqliteViewer.empty.noRows')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="project-editor-sqlite-pagination">
        <div className="project-editor-sqlite-pagination-left">
          <span data-testid="sqlite-page-info">
            {t('sqliteViewer.pagination.info', { currentPage, totalPages, totalRows })}
          </span>
        </div>
        <div className="project-editor-sqlite-pagination-center" />
        <div className="project-editor-sqlite-pagination-right">
          <label htmlFor="sqlite-page-size-select">{t('sqliteViewer.pagination.perPage')}</label>
          <div className="onward-select-shell">
            <select
              id="sqlite-page-size-select"
              className="project-editor-sqlite-pagination-select onward-select onward-select--compact-xs"
              data-testid="sqlite-page-size-select"
              value={pageSize}
              onChange={(event) => handlePageSizeChange(Number(event.target.value))}
              disabled={!activeTable || rowsLoading}
            >
              {PAGE_SIZE_OPTIONS.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          <span>{t('sqliteViewer.pagination.rows')}</span>
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-page-prev"
            onClick={() => {
              if (!activeTable || !canPrevPage) return
              const nextOffset = Math.max(0, offset - pageSize)
              void loadRows(activeTable, nextOffset, pageSize)
            }}
            disabled={!activeTable || !canPrevPage || rowsLoading}
          >
            {t('sqliteViewer.pagination.previous')}
          </button>
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-page-next"
            onClick={() => {
              if (!activeTable || !canNextPage) return
              const nextOffset = offset + pageSize
              void loadRows(activeTable, nextOffset, pageSize)
            }}
            disabled={!activeTable || !canNextPage || rowsLoading}
          >
            {t('sqliteViewer.pagination.next')}
          </button>
          <label htmlFor="sqlite-jump-page">{t('sqliteViewer.pagination.jump')}</label>
          <input
            id="sqlite-jump-page"
            data-testid="sqlite-page-jump-input"
            className="project-editor-sqlite-jump-input"
            value={jumpPageInput}
            onChange={(event) => setJumpPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleJumpPage()
              }
            }}
            disabled={!activeTable || rowsLoading}
          />
          <button
            className="project-editor-action-btn"
            data-testid="sqlite-page-jump-button"
            onClick={handleJumpPage}
            disabled={!activeTable || rowsLoading}
          >
            {t('sqliteViewer.pagination.jump')}
          </button>
        </div>
      </div>

      {sqlConsoleVisible && (
        <div className="project-editor-sqlite-console" data-testid="sqlite-sql-console">
          <div className="project-editor-sqlite-console-header">
            {t('sqliteViewer.sql.consoleTitle')}
            <span>{t('sqliteViewer.sql.readonlyHint')}</span>
          </div>
          <textarea
            data-testid="sqlite-sql-input"
            value={sqlInput}
            onChange={(event) => setSqlInput(event.target.value)}
            spellCheck={false}
          />
          <div className="project-editor-sqlite-console-actions">
            <button
              className="project-editor-action-btn"
              data-testid="sqlite-sql-run"
              onClick={() => void handleRunSql()}
              disabled={sqlRunning}
            >
              {sqlRunning ? t('sqliteViewer.sql.running') : t('sqliteViewer.sql.run')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
