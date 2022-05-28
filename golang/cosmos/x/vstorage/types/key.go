package types

const (
	// module name
	ModuleName = "vstorage"

	// StoreKey to be used when creating the KVStore
	StoreKey = ModuleName
)

var (
	LegacyDataKeyPrefix = []byte("swingset/data")
	DataKeyPrefix       = LegacyDataKeyPrefix // TODO: []byte{1}
	MetaKeyPrefix       = []byte{0}
	BatchKeyPrefix      = MetaKeyPrefix
)
