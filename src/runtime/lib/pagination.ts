// externals
import { derived, get, readable, Readable, Writable, writable } from 'svelte/store'
// locals
import cache from '../cache'
import { executeQuery } from './network'
import { GraphQLObject, QueryArtifact } from './types'
// this has to be in a separate file since config isn't defined in cache/index.ts
import { FragmentStore, QueryResult, QueryStore, QueryStoreParams } from '..'
import { getHoudiniContext } from './context'
import { ConfigFile, keyFieldsForType } from './config'
import { LoadContext } from './types'
import { countPage, extractPageInfo } from './utils'

type RefetchFn<_Data = any, _Input = any> = (
	params?: QueryStoreParams<_Input>
) => Promise<QueryResult<_Data, _Input>>

export function wrapPaginationStore<_Data, _Input>(
	store: QueryStore<_Data, _Input> | FragmentStore<_Data>
) {
	// @ts-ignore
	const { loadNextPage, loadPreviousPage, ...rest } = store

	// grab the current houdini context
	const context = getHoudiniContext()

	const result = rest
	if (loadNextPage) {
		// @ts-ignore
		result.loadNextPage = (...args) => loadNextPage(context, ...args)
	}
	if (loadPreviousPage) {
		// @ts-ignore
		result.loadPreviousPage = (...args) => loadPreviousPage(context, ...args)
	}

	return result
}

export function fragmentHandlers<_Data extends GraphQLObject, _Input>({
	config,
	paginationArtifact,
	initialValue,
	store,
}: {
	config: ConfigFile
	paginationArtifact: QueryArtifact
	initialValue: _Data
	store: Readable<GraphQLObject>
}) {
	const { targetType } = paginationArtifact.refetch || {}
	const typeConfig = config.types?.[targetType || '']
	if (!typeConfig) {
		throw new Error(
			`Missing type refetch configuration for ${targetType}. For more information, see https://www.houdinigraphql.com/guides/pagination#paginated-fragments`
		)
	}

	let queryVariables = () => ({} as _Input)
	// if the query is embedded we have to figure out the correct variables to pass
	if (paginationArtifact.refetch!.embedded) {
		// if we have a specific function to use when computing the variables
		if (typeConfig.resolve?.arguments) {
			queryVariables = () => (typeConfig.resolve!.arguments?.(initialValue) || {}) as _Input
		} else {
			const keys = keyFieldsForType(config, targetType || '')
			queryVariables = () =>
				// @ts-ignore
				Object.fromEntries(keys.map((key) => [key, initialValue[key]])) as _Input
		}
	}

	return paginationHandlers<_Data, _Input>({
		config,
		initialValue,
		store,
		artifact: paginationArtifact,
		queryVariables,
		refetch: async () => {
			return {} as any
		},
	})
}

export function queryHandlers<_Data extends GraphQLObject, _Input>({
	config,
	artifact,
	store,
	queryVariables,
}: {
	config: ConfigFile
	artifact: QueryArtifact
	store: QueryStore<any, any>
	queryVariables: () => _Input
}) {
	// if there's no refetch config for the artifact there's a problem
	if (!artifact.refetch) {
		throw new Error('paginatedQuery must be passed a query with @paginate.')
	}

	// create some derived stores from the query meta data
	const loading = derived([store], ([$store]) => $store.isFetching)
	const data = derived([store], ([$store]) => $store.data)

	// return the handlers
	return paginationHandlers<_Data, _Input>({
		documentLoading: loading,
		initialValue: get(store).data || {},
		artifact,
		store: data,
		queryVariables,
		refetch: store.fetch,
		config,
	})
}

function paginationHandlers<_Data extends GraphQLObject, _Input>({
	initialValue,
	artifact,
	store,
	queryVariables,
	documentLoading,
	refetch,
	config,
}: {
	initialValue: GraphQLObject
	artifact: QueryArtifact
	store: Readable<GraphQLObject>
	queryVariables: () => _Input
	documentLoading?: Readable<boolean>
	refetch: RefetchFn<_Data, _Input>
	config: ConfigFile
}): PaginatedHandlers<_Data, _Input> {
	// start with the defaults and no meaningful page info
	let loadPreviousPage: PaginatedHandlers<_Data, _Input>['loadPreviousPage'] = async (
		...args: Parameters<PaginatedHandlers<_Data, _Input>['loadPreviousPage']>
	) => {}
	let loadNextPage: PaginatedHandlers<_Data, _Input>['loadNextPage'] = async (
		...args: Parameters<PaginatedHandlers<_Data, _Input>['loadNextPage']>
	) => {}
	let pageInfo = readable<PageInfo>(
		{
			startCursor: null,
			endCursor: null,
			hasNextPage: false,
			hasPreviousPage: false,
		},
		() => {}
	)

	// loading state
	let paginationLoadingState = writable(false)

	let refetchQuery: RefetchFn<_Data, _Input>
	// if the artifact supports cursor based pagination
	if (artifact.refetch?.method === 'cursor') {
		// generate the cursor handlers
		const cursor = cursorHandlers<_Data, _Input>({
			initialValue,
			artifact,
			store,
			queryVariables,
			loading: paginationLoadingState,
			refetch,
			config,
		})
		// always track pageInfo
		pageInfo = cursor.pageInfo
		// always use the refetch fn
		refetchQuery = cursor.refetch

		// if we are implementing forward pagination
		if (artifact.refetch.update === 'append') {
			loadNextPage = cursor.loadNextPage
		}
		// the artifact implements backwards pagination
		else {
			loadPreviousPage = cursor.loadPreviousPage
		}
	}
	// the artifact supports offset-based pagination, only loadNextPage is valid
	else {
		const offset = offsetPaginationHandler<_Data, _Input>({
			initialValue,
			artifact,
			queryVariables,
			loading: paginationLoadingState,
			refetch,
			store,
		})

		loadNextPage = offset.loadPage
		refetchQuery = offset.refetch
	}

	// if no loading state was provided just use a store that's always false
	if (!documentLoading) {
		documentLoading = readable(false, () => {})
	}

	// merge the pagination and document loading state
	const loading = derived(
		[paginationLoadingState, documentLoading],
		($loadingStates) => $loadingStates[0] || $loadingStates[1]
	)

	return { loadNextPage, loadPreviousPage, pageInfo, loading, refetch: refetchQuery }
}

function cursorHandlers<_Data extends GraphQLObject, _Input>({
	config,
	initialValue,
	artifact,
	store,
	queryVariables: extraVariables,
	loading,
	refetch,
}: {
	config: ConfigFile
	initialValue: GraphQLObject
	artifact: QueryArtifact
	store: Readable<GraphQLObject>
	queryVariables: () => _Input
	loading: Writable<boolean>
	refetch: RefetchFn
}): PaginatedHandlers<_Data, _Input> {
	// track the current page info in an easy-to-reach store
	const initialPageInfo = extractPageInfo(initialValue, artifact.refetch!.path) ?? {
		startCursor: null,
		endCursor: null,
		hasNextPage: false,
		hasPreviousPage: false,
	}

	const pageInfo = writable<PageInfo>(initialPageInfo)

	// hold onto the current value
	let value = initialValue
	store.subscribe((val) => {
		pageInfo.set(extractPageInfo(val, artifact.refetch!.path))
		value = val
	})

	// dry up the page-loading logic
	const loadPage = async ({
		houdiniContext,
		pageSizeVar,
		input,
		functionName,
	}: {
		houdiniContext: LoadContext
		pageSizeVar: string
		functionName: string
		input: {}
	}) => {
		// set the loading state to true
		loading.set(true)

		// build up the variables to pass to the query
		const loadVariables: Record<string, any> = {
			...extraVariables?.(),
			...houdiniContext.variables(),
			...input,
		}

		// if we don't have a value for the page size, tell the user
		if (!loadVariables[pageSizeVar] && !artifact.refetch!.pageSize) {
			throw missingPageSizeError(functionName)
		}

		// send the query
		const { result, partial: partialData } = await executeQuery<GraphQLObject, {}>(
			artifact,
			loadVariables,
			houdiniContext.session,
			false
		)

		// if the query is embedded in a node field (paginated fragments)
		// make sure we look down one more for the updated page info
		const resultPath = [...artifact.refetch!.path]
		if (artifact.refetch!.embedded) {
			const { targetType } = artifact.refetch!
			// make sure we have a type config for the pagination target type
			if (!config.types?.[targetType]?.resolve) {
				throw new Error(
					`Missing type resolve configuration for ${targetType}. For more information, see https://www.houdinigraphql.com/guides/pagination#paginated-fragments`
				)
			}

			// make sure that we pull the value out of the correct query field
			resultPath.unshift(config.types[targetType].resolve!.queryField)
		}

		// we need to find the connection object holding the current page info
		pageInfo.set(extractPageInfo(result.data, resultPath))

		// update cache with the result
		cache.write({
			selection: artifact.selection,
			data: result.data,
			variables: loadVariables,
			applyUpdates: true,
		})

		// we're not loading any more
		loading.set(false)
	}

	return {
		loading,
		loadNextPage: async (houdiniContext: LoadContext, pageCount?: number) => {
			// we need to find the connection object holding the current page info
			const currentPageInfo = extractPageInfo(value, artifact.refetch!.path)

			// if there is no next page, we're done
			if (!currentPageInfo.hasNextPage) {
				return
			}

			// only specify the page count if we're given one
			const input: Record<string, any> = {
				after: currentPageInfo.endCursor,
			}
			if (pageCount) {
				input.first = pageCount
			}

			// load the page
			return await loadPage({
				houdiniContext,
				pageSizeVar: 'first',
				functionName: 'loadNextPage',
				input,
			})
		},
		loadPreviousPage: async (houdiniContext: LoadContext, pageCount?: number) => {
			// we need to find the connection object holding the current page info
			const currentPageInfo = extractPageInfo(value, artifact.refetch!.path)

			// if there is no next page, we're done
			if (!currentPageInfo.hasPreviousPage) {
				return
			}

			// only specify the page count if we're given one
			const input: Record<string, any> = {
				before: currentPageInfo.startCursor,
			}
			if (pageCount) {
				input.last = pageCount
			}

			// load the page
			return await loadPage({
				houdiniContext,
				pageSizeVar: 'last',
				functionName: 'loadPreviousPage',
				input,
			})
		},
		pageInfo: { subscribe: pageInfo.subscribe },
		async refetch(params?: QueryStoreParams<_Input>): Promise<QueryResult<_Data, _Input>> {
			const { variables } = params ?? {}

			// build up the variables to pass to the query
			const queryVariables: Record<string, any> = {
				...extraVariables(),
				...variables,
			}

			// if the input is different than the query variables then we just do everything like normal
			if (variables && JSON.stringify(extraVariables()) !== JSON.stringify(variables)) {
				return refetch(params)
			}

			// we are updating the current set of items, count the number of items that currently exist
			// and ask for the full data set
			const count =
				countPage(artifact.refetch!.path.concat('edges'), value) ||
				artifact.refetch!.pageSize

			// only include the count value if its not the refetch page size (generated with default value)
			if (count && count !== artifact.refetch!.pageSize) {
				// reverse cursors need the last entries in the list
				queryVariables[artifact.refetch!.update === 'prepend' ? 'last' : 'first'] = count
			}

			// set the loading state to true
			loading.set(true)

			// send the query
			const result = await refetch({
				...params,
				variables: queryVariables,
			})

			// update cache with the result
			const returnValue = {
				selection: artifact.selection,
				data: result.data,
				variables: queryVariables as _Input,
				// overwrite the current data
				applyUpdates: false,
				isFetching: false,
				partial: result.partial,
				errors: null,
				source: result.source,
			}
			cache.write(returnValue)

			// we're not loading any more
			loading.set(false)

			return returnValue
		},
	}
}

function offsetPaginationHandler<_Data extends GraphQLObject, _Input>({
	artifact,
	queryVariables: extraVariables,
	loading,
	refetch,
	initialValue,
	store,
}: {
	artifact: QueryArtifact
	queryVariables: () => _Input
	loading: Writable<boolean>
	refetch: RefetchFn
	initialValue: GraphQLObject
	store: Readable<GraphQLObject>
}): {
	loadPage: PaginatedHandlers<_Data, _Input>['loadNextPage']
	refetch: PaginatedHandlers<_Data, _Input>['refetch']
} {
	// we need to track the most recent offset for this handler
	let currentOffset =
		(artifact.refetch?.start as number) ||
		countPage(artifact.refetch!.path, initialValue) ||
		artifact.refetch!.pageSize

	// hold onto the current value
	let value = initialValue
	store.subscribe((val) => {
		value = val
	})

	return {
		loadPage: async (houdiniContext: LoadContext, limit?: number) => {
			// build up the variables to pass to the query
			const queryVariables: Record<string, any> = {
				...houdiniContext.variables(),
				...extraVariables(),
				offset: currentOffset,
			}
			if (limit) {
				queryVariables.limit = limit
			}

			// if we made it this far without a limit argument and there's no default page size,
			// they made a mistake
			if (!queryVariables.limit && !artifact.refetch!.pageSize) {
				throw missingPageSizeError('loadNextPage')
			}

			// set the loading state to true
			loading.set(true)

			// send the query
			const { result, partial: partialData } = await executeQuery<GraphQLObject, {}>(
				artifact,
				queryVariables,
				houdiniContext.session,
				false
			)

			// update cache with the result
			cache.write({
				selection: artifact.selection,
				data: result.data,
				variables: queryVariables,
				applyUpdates: true,
			})

			// add the page size to the offset so we load the next page next time
			const pageSize = queryVariables.limit || artifact.refetch!.pageSize
			currentOffset += pageSize

			// we're not loading any more
			loading.set(false)
		},
		async refetch(params?: QueryStoreParams<_Input>): Promise<QueryResult<_Data, _Input>> {
			const { variables } = params ?? {}

			// if the input is different than the query variables then we just do everything like normal
			if (variables && JSON.stringify(extraVariables()) !== JSON.stringify(variables)) {
				return refetch(params)
			}

			// we are updating the current set of items, count the number of items that currently exist
			// and ask for the full data set
			const count = countPage(artifact.refetch!.path, value) || artifact.refetch!.pageSize

			// build up the variables to pass to the query
			const queryVariables: Record<string, any> = {
				...extraVariables(),
			}
			if (count !== artifact.refetch!.pageSize) {
				queryVariables.limit = count
			}

			// set the loading state to true
			loading.set(true)

			// send the query
			const result = await refetch({
				...params,
				variables: queryVariables,
			})

			// we're not loading any more
			loading.set(false)

			// update cache with the result
			const returnValue = {
				selection: artifact.selection,
				data: result.data,
				variables: queryVariables as _Input,
				applyUpdates: false,
				isFetching: false,
				partial: result.partial,
				errors: null,
				source: result.source,
			}
			cache.write(returnValue)

			// we're not loading any more
			loading.set(false)

			return returnValue
		},
	}
}
export type PaginatedDocumentHandlers<_Data, _Input> = {
	loadNextPage(pageCount?: number, after?: string | number): Promise<void>
	loadPreviousPage(pageCount?: number, before?: string): Promise<void>
	loading: Readable<boolean>
	pageInfo: Readable<PageInfo>
	refetch: (vars?: _Input) => Promise<_Data>
}

export type PaginatedHandlers<_Data, _Input> = {
	loadNextPage(
		houdiniContext: LoadContext,
		pageCount?: number,
		after?: string | number
	): Promise<void>
	loadPreviousPage(
		houdiniContext: LoadContext,
		pageCount?: number,
		before?: string
	): Promise<void>
	loading: Readable<boolean>
	pageInfo: Readable<PageInfo>
	refetch: RefetchFn<_Data, _Input>
}

function missingPageSizeError(fnName: string) {
	return
}

export type PageInfo = {
	startCursor: string | null
	endCursor: string | null
	hasNextPage: boolean
	hasPreviousPage: boolean
}
