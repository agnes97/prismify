import { Prisma, Item, Category, CompareMethod } from '@prisma/client'

import { Item as InputItem } from './item.validation.js'

export function transformInputItems(inputItems: InputItem[]): Item[] {
  const items = inputItems.map((inputItem) => ({
    id: inputItem.id,
    title: inputItem.title,
    description: inputItem.description,
    countryCode: inputItem.user.country_code,
    priceNumeric: inputItem.price_numeric,
    currency: inputItem.currency,
    url: inputItem.url,
    brand: inputItem.brand,
    thumbnailSrc: inputItem.photos[0].thumbnails[2].url,
    lastActivity: inputItem.user.last_loged_on_ts,
    isReserved: inputItem.is_reserved === 1,
    isSold: inputItem.item_closing_action === 'sold',
  }))

  return items
}

type CategoryType = Prisma.CategoryTypeGetPayload<{
  include: { categories: true }
}>

type ItemWithCategories = Prisma.ItemGetPayload<{
  include: { categories: true }
}>

export function categorizeItems(
  categoryTypes: CategoryType[],
  items: Item[],
): ItemWithCategories[] {
  const getItemCategories = createItemCategoriesMapper(categoryTypes)

  const itemsWithCategories = items.map((item) => {
    const categories = getItemCategories(item)

    return {
      ...item,
      categories,
    }
  })

  return itemsWithCategories
}

type ItemCategoriesMapper = (item: Item) => Category[]

function createItemCategoriesMapper(
  categoryTypes: CategoryType[],
): ItemCategoriesMapper {
  const itemCategoriesMappers = categoryTypes.map(createItemCategoryTypeMapper)
  return (item) => itemCategoriesMappers.flatMap((mapper) => mapper(item))
}

const isItemProperty =
  (item: Item) =>
  (property: string): property is keyof Item =>
    property in item

function createItemCategoryTypeMapper(
  categoryType: CategoryType,
): ItemCategoriesMapper {
  const { categories, places, lowercase, compare } = categoryType

  return (item: Item) => {
    const itemProperties = places.filter(isItemProperty(item))

    const options = {
      itemProperties,
      compareMethod: compare,
      lowercase,
    }

    return categories.filter((category) =>
      belongsToCategery(item, category, options),
    )
  }
}

function belongsToCategery(
  item: Item,
  category: Category,
  options: {
    itemProperties: Array<keyof Item>
    compareMethod: CompareMethod
    lowercase: boolean
  },
): boolean {
  const itemValues = options.itemProperties.map((property) => {
    const value = item[property].toString()
    return options.lowercase ? value.toLowerCase() : value
  })

  return category.keys.some((key) =>
    itemValues.some((value) => {
      switch (options.compareMethod) {
        case 'EQUAL':
          return value === key
        case 'INCLUDES':
          return value.includes(key)
      }
    }),
  )
}
